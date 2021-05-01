/**
 *  @file       kvin.js                A general-purpose library for marshaling and serializing
 *                                      ES objects.  This library is a functional superset of JSON
 *                                      and relies on JSON for speed, adding:
 *                                      - Typed Arrays with efficient spare representation
 *                                      - Sparse arrays
 *                                      - Arrays with enumerable properties
 *                                      - Object graphs with cycles
 *                                      - Boxed primitives (excluding Symbol)
 *                                      - Functions (including enumerable properties, global scope)
 *                                      - Regular Expressions
 *                                      - undefined
 *                                      - simple objects made with constructors
 *                                        - objects will re-constructed with no constructor arguments
 *                                          during deserialization
 *                                        - enumerable properties will be copied on after construction
 *                                      - optional whitelisting of supported constructors
 *
 *                                      This library is safe to use on user-supplied data.
 *
 *                                      The basic implementation strategy is to marshal to an intermediate
 *                                      format, called a 'prepared object', that can be used to recreate
 *                                      the original object, but can also be serialized with JSON. We
 *                                      track a list objects we have seen and their initial appearance in
 *                                      the object graph.  We rely on the /de-facto/ enumeration order of
 *                                      properties in vanilla objects that has been present in all popular
 *                                      browsers since the dawn of time; namely, that enumeration order is
 *                                      object insertion order.  This could cause bugs with objects with
 *                                      cycles in less-common interpreters, such as Rhino and (especially)
 *                                      the NJS/NGS ES3 platform by Brian Basset.
 *
 *  *note* -    This module free of external dependencies, and can be loaded as either a Node module,
 *              a BravoJS module, or as a script tag in the browser.
 *
 *  *bugs* -    There are known or suspected issues in the following areas:
 *              - Arrays which contain the same object more than once
 *              - Arrays which mix numeric and non-numeric properties, especially if they are objects
 *              - Sparse Arrays
 *
 *  @author     Wes Garland, wes@kingsds.network
 *  @date       June 2018
 *
 */

"use strict";

/* This prologue allows a CJS2 module's exports to be loaded with eval(readFileSync(filename)) */
var _md
if (typeof module === 'undefined' || typeof module.declare === 'undefined') {
  _md = (typeof module === 'object') ? module.declare : null
  if (typeof module !== 'object') {
    module = { exports: {} }  // eslint-disable-line
  }
  module.declare = function moduleUnWrapper (deps, factory) {
    factory(null, module.exports, module)
    return module.exports
  }
}

/* eslint-disable indent */ module.declare([], function (require, exports, module) {
/*
 * Set exports.makeFunctions = true to allow deserializer to make functions.
 * If the deserializer can make functions, it is equivalent to eval() from a
 * security POV.  Otherwise, the deserializer will turn functions into boxed
 * strings containing the function's source code, having a name property that
 * matches the original function.
 */
exports.makeFunctions = false

/* More bytes in a TypedArray than typedArrayPackThreshold will trigger
 * the code to prepare these into strings rather than arrays.
 */
exports.typedArrayPackThreshold = 8

/* Arrays of primitives which are >= the threshold in length are scrutinized
 * for further optimization, e.g. by run-length encoding
 */
exports.scanArrayThreshold = 8

/** Maxmimum number of arguments we can pass to a function in this engine.
 * @todo this needs to be detected at startup based on environment
 */
const _vm_fun_maxargs = 100000

const littleEndian = (function () {
  let ui16 = new Uint16Array(1)
  let ui8

  ui16[0] = 0xffef
  ui8 = new Uint8Array(ui16.buffer, ui16.byteOffset, ui16.byteLength)

  if (ui8[0] === 0x0ff) {
    console.log('Detected big-endian platform')
    return false
  }

  return true
})()

/** Pre-defined constructors, used to compact payload */
const ctors = [
  Object,
  Int8Array,
  Uint8Array,
  Uint8ClampedArray,
  Int16Array,
  Uint16Array,
  Int32Array,
  Uint32Array,
  Float32Array,
  Float64Array,
  RegExp,
  Number,
  String,
  Boolean,
  Array,
  Function,
  URL,
];

exports.userCtors = {}; /**< name: implementation for user-defined constructors that are not props of global */

Number.isInteger = Number.isInteger || function Number$$isInteger_polyfill(value) {
  return typeof value === 'number' && 
    isFinite(value) && 
    Math.floor(value) === value;
};
  
/** Take a 'prepared object' (which can be represented by JSON) and turn it
 *  into an object which resembles the object it was created from.
 *
 *  @param      seen            An array objects we have already seen in this
 *                              object graph; used to track cycles.
 *  @param      po              A prepared object representing a value or a primitive
 *  @param      position        A string respresenting our position within
 *                              the graph. Used only for error messages.
 *  @returns    the value encoded by po
 */
function unprepare (seen, po, position) {
  switch (typeof po) {
    case 'boolean':
    case 'number':
    case 'string':
      return po;
  }
  if (po.hasOwnProperty('ctr')) {
    switch (typeof po.ctr) {
    case 'string':
      if (!po.ctr.match(/^[A-Za-z_0-9$][A-Za-z_0-9$]*$/)) {
        if (exports.constructorWhitelist && exports.constructorWhitelist.indexOf(po.ctr) === -1) {
          throw new Error('Whitelist does not include constructor ' + po.ctr)
        }
        throw new Error('Invalid constructor name: ' + po.ctr)
      }
      break
    case 'number':
      if (!(po.ctr >= 0 && po.ctr < ctors.length)) {
        throw new Error('Invalid constructor number: ' + po.ctr)
      }
      break
    default:
      throw new Error('Invalid constructor label type ' + typeof po.ctr)
    }
  }
  if (po.hasOwnProperty('raw')) {
    return po.raw;
  }
  if (po.hasOwnProperty('ptv')) {
    return po.ptv; /* deprecated: only created by v3-6 */
  }
  if (po.hasOwnProperty('number')) {
    return unprepare$number(po.number);
  }
  if (po.hasOwnProperty('fnName')) {
    return unprepare$function(seen, po, position)
  }
  if (po.hasOwnProperty('ab16') || po.hasOwnProperty('isl16')) {
    return unprepare$ArrayBuffer16(po, position)
  }
  if (po.hasOwnProperty('ab8') || po.hasOwnProperty('isl8')) {
    return unprepare$ArrayBuffer8(po, position)
  }
  if (po.hasOwnProperty('arr')) {
    return unprepare$Array(seen, po, position)
  }
  if (po.hasOwnProperty('ctr')) {
    return unprepare$object(seen, po, position)
  }
  if (po.hasOwnProperty('json')) {
    return JSON.parse(po.json)
  }
  if (po.hasOwnProperty('undefined')) {
    return undefined
  }

  if (Object.hasOwnProperty.call(po, 'resolve')) {
    // Unprepare a Promise by assuming po.resolve is a marshalled value.
    const promise = Promise.resolve(exports.unmarshal(po.resolve));
    seen.push(promise);
    return promise;
  }

  if (po.hasOwnProperty('seen')) {
    if (!seen.hasOwnProperty(po.seen)) {
      throw new Error('Seen-list corruption detected at index ' + po.seen)
    }
    return seen[po.seen]
  }
  throw new TypeError('Invalid preparation formula at ' + position)
}

function unprepare$object (seen, po, position) {
  let o
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    if (exports.userCtors.hasOwnProperty(po.ctr))
      constructor = exports.userCtors[po.ctr];
    else
      constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = ctors[po.ctr]
  }

  if (po.hasOwnProperty('arg')) {
    o = new constructor(po.arg)
  } else {
    o = new constructor() // eslint-disable-line
  }

  seen.push(o)

  if (po.hasOwnProperty('ps')) {
    for (let prop in po.ps) {
      if (po.ps.hasOwnProperty(prop)) {
        o[prop] = unprepare(seen, po.ps[prop], position + '.' + prop)
      }
    }
  }

  return o
}

function unprepare$function (seen, po, position) {
  let obj, fn
  let fnName = po.fnName

  /* A function is basically a callable object */
  po.ctr = ctors.indexOf(Object)
  delete po.fnName
  obj = unprepare(seen, po, position)

  if (!exports.makeFunctions) {
    obj.name = fnName
    return obj
  }

  fn = (new Function('return ' + po.arg))()  // eslint-disable-line
  if (po.hasOwnProperty('ps')) {
    for (let prop in po.ps) {
      fn[prop] = obj[prop]
    }
  }

  return fn
}

function unprepare$number(arg) {
  return parseFloat(arg);
}
  
/**
 * arr:[] - Array of primitives of prepared objects
 * lst:N - repeat last element N times
 * ps:[] - property list
 */
function unprepare$Array (seen, po, position) {
  let a = []
  let last

  seen.push(a)

  for (let i = 0; i < po.arr.length; i++) {
    if (typeof po.arr[i] === 'object') {
      if (po.arr[i].lst) {
        for (let j = 0; j < po.arr[i].lst; j++) {
          a.push(unprepare(seen, last, position + '.' + (i + j)))
        }
        continue
      }
      a.push(unprepare(seen, po.arr[i], position + '.' + i))
      last = po.arr[i]
    } else {
      a.push(po.arr[i])
      last = prepare$primitive(a[i], 'unprepare$Array')
    }
  }

  if (po.hasOwnProperty('isl')) {
    for (let prop in po.isl) {
      let island = po.isl[prop]
      let els = Array.isArray(island.arr) ? island.arr : unprepare$Array(seen, island.arr, [ position, 'isl', prop ].join('.'))

      if (els.length - 3 <= _vm_fun_maxargs) {
        if (els.length && (a.length < island['@'] + els.length)) {
          a.length = island['@'] + els.length
        }
        a.splice.apply(a, [island['@'], els.length].concat(els))
      } else {
        for (let i=0; i < els.length; i++) {
          a[i + +island['@']] = els[i]
        }
      }
    }
  }

  if (po.hasOwnProperty('ps')) {
    for (let prop in po.ps) {
      if (typeof po.ps[prop] === 'object') {
        a[prop] = unprepare(seen, po.ps[prop], position + '.' + prop)
      } else {
        a[prop] = po.ps[prop]
      }
    }
  }

  if (po.len) {
    a.length = po.len
  }

  return a
}

/** The ab8 (array buffer 8 bit) encoding encodes TypedArrays and related types by
 *  converting them to Latin-1 strings full of binary data in 8-bit words.
 *
 *  The isl8 (islands) encoding is almost the same, except that it encodes only
 *  sequences of mostly-non-zero sections of the string.
 */
function unprepare$ArrayBuffer8 (po, position) {
  let i8
  let bytes
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = ctors[po.ctr]
  }

  if (po.hasOwnProperty('ab8')) {
    bytes = po.ab8.length
  } else {
    bytes = po.len
  }
  i8 = new Int8Array(bytes)
  if (po.hasOwnProperty('ab8')) {
    for (let i = 0; i < po.ab8.length; i++) {
      i8[i] = po.ab8.charCodeAt(i)
    }
  } else {
    for (let j = 0; j < po.isl8.length; j++) {
      for (let i = 0; i < po.isl8[j][0].length; i++) {
        i8[po.isl8[j]['@'] + i] = po.isl8[j][0].charCodeAt(i)
      }
    }
  }
  return new constructor(i8.buffer, i8.byteOffset) // eslint-disable-line
}

/** The ab16 (array buffer 16 bit) encoding encodes TypedArrays and related types by
 *  converting them to strings full of binary data in 16-bit words. Buffers
 *  with an odd number of bytes encode an extra byte 'eb' at the end by itself.
 *
 *  The isl16 (islands) encoding is almost the same, except that it encodes only
 *  sequences of mostly-non-zero sections of the string.
 */
function unprepare$ArrayBuffer16 (po, position) {
  let i16, i8, words
  let bytes
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = ctors[po.ctr]
  }

  if (po.hasOwnProperty('ab16')) {
    bytes = po.ab16.length * 2
    if (po.hasOwnProperty('eb')) {
      bytes++
    }
  } else {
    bytes = po.len
  }

  words = Math.floor(bytes / 2) + (bytes % 2)
  i16 = new Int16Array(words)
  if (po.hasOwnProperty('ab16')) {
    for (let i = 0; i < po.ab16.length; i++) {
      i16[i] = po.ab16.charCodeAt(i)
    }
  } else {
    for (let j = 0; j < po.isl16.length; j++) {
      for (let i = 0; i < po.isl16[j][0].length; i++) {
        i16[po.isl16[j]['@'] + i] = po.isl16[j][0].charCodeAt(i)
      }
    }
  }
  i8 = new Int8Array(i16.buffer, i16.byteOffset, bytes)
  if (po.hasOwnProperty('eb')) {
    i8[i8.byteLength - 1] = po.eb.charCodeAt(0)
  }

  if (!littleEndian) {
    for (let i = 0; i < i8.length; i += 2) {
      i8[(i * 2) + 0] = i8[(i * 2) + 0] ^ i8[(i * 2) + 1]
      i8[(i * 2) + 1] = i8[(i * 2) + 1] ^ i8[(i * 2) + 0]
      i8[(i * 2) + 0] = i8[(i * 2) + 0] ^ i8[(i * 2) + 1]
    }
  }

  return new constructor(i8.buffer, i8.byteOffset) // eslint-disable-line
}

/* Primitives and primitive-like objects do not have any special
 * marshaling requirements -- specifically, we don't need to
 * iterate over their properties in order to serialize them; we
 * can let JSON.stringify() do any heavy lifting.
 */
function isPrimitiveLike (o) {
  if (o === null || typeof o === 'string' || typeof o === 'boolean')
    return true;

  if (typeof o === 'number')
    return Number.isFinite(o);

  if (typeof o !== 'object')
    return false;
  
  if (o.constructor === Object && Object.keys(o).length === 0)
    return true;

  if (o.constructor === Array && o.length === 0 && Object.keys(o).length === 0)
    return true;

  if (o.constructor !== Object && o.constructor !== Array)
    return false;

  if (Array.isArray(o)) {
    if (Object.keys(o).length !== o.length) {
      return false /* sparse array or named props */
    }
  }

  for (let prop in o) {
    if (!o.hasOwnProperty(prop))
      return false;
    if (!isPrimitiveLike(o[prop]))
      return false;
  }

  return true
}

/** Take an arbitrary object and turn it into a 'prepared object'.
 *  A prepared object can always be represented with JSON.
 *
 *  @param      seen    An array objects we have already seen in this
 *                      object graph; used to track cycles.
 *  @param      o       The object that the prepared object reflects
 *  @returns            A prepared object
 */
function prepare (seen, o, where) {
  let i, ret
  let po = {}

  if (isPrimitiveLike(o)) {
    if (!Array.isArray(o) || o.length < exports.scanArrayThreshold)
      return prepare$primitive(o, where)
  }
  if (typeof o === 'number') {
    return prepare$number(o)
  }
  if (typeof o === 'undefined') {
    return prepare$undefined(o)
  }
  /* value types below here can be used as targets of cycles */
  if ((i = seen.indexOf(o)) === -1) {
    seen.push(o)
  } else {
    return { seen: i }
  }
  if (Array.isArray(o)) {
    return prepare$Array(seen, o, where)
  }
  if (ArrayBuffer.isView(o)) {
    return prepare$ArrayBuffer(o)
  }
  if (o.constructor === String || o.constructor === Number || o.constructor === Boolean) {
    return prepare$boxedPrimitive(o)
  }
  if (o.constructor === RegExp) {
    return prepare$RegExp(o)
  }

  if (o instanceof Promise) {
    /**
     * Let the caller replace the `resolve` property with its marshalled
     * resolved value.
     */
    return { resolve: o };
  }

  if (typeof o.constructor === 'undefined') {
    console.log('Warning: ' + where + ' is missing .constructor -- skipping')
    return prepare$undefined(o)
  }

  ret = { ctr: ctors.indexOf(o.constructor), ps: po }
  if (ret.ctr === -1) {
    /**
     * If the constructor is `Object` from another context, the indexOf check
     * would fail. So if the name of `o`'s constructor matches one of the valid
     * constructors, use the index from the mapped array to get the proper
     * constructor index.
     */
    const constructorNames = ctors.map((ctor) => ctor.name);
    const ctrIndex = constructorNames.indexOf(o.constructor.name);
    if (ctrIndex !== -1) {
      ret.ctr = ctrIndex;
      /**
       * Fix the `o`'s constructor to match its constructor in the current
       * context so that later equality/instanceof checks don't fail.
       */
      o.constructor = ctors[ctrIndex];
    } else {
      ret.ctr = o.constructor.name || ctors.indexOf(Object)
    }
  }

  if (typeof o === 'function') {
    ret.fnName = o.name
  }

  if (typeof o.toJSON === 'function') {
    ret.arg = o.toJSON()
  } else {
    if (o.constructor !== Object)
      ret.arg = o.toString()
  }

  if (typeof o.hasOwnProperty === 'undefined') {
    console.log('Warning: ' + where + ' is missing .hasOwnProperty -- skipping')
    return prepare$undefined(o)
  }

  /* Iterate over the properties and prepare each in turn, recursing
   * with a depth-first traversal of the object graph. Iteration order
   * must match unprepare()!
   */
  for (let prop in o) {
    if (!o.hasOwnProperty(prop)) {
      continue
    }

    switch (typeof o[prop]) {
      case 'function':
      case 'object':
        if (o[prop] !== null) {
          if (typeof o[prop].constructor !== 'undefined'
              && o[prop].constructor !== Object && o[prop].constructor.constructor !== Object
              && o[prop].constructor !== Function && o[prop].constructor.constructor !== Function
              && o[prop].constructor !== Function && o[prop].constructor.constructor.name !== "Function" /* vm context issue /wg aug 2020 */
             ) {
            throw new Error(`Cannot serialize property ${where}.${prop} - multiple inheritance is not supported.`);
          }
          if ((i = seen.indexOf(o[prop])) === -1) {
            po[prop] = prepare(seen, o[prop], where + '.' + prop)
          } else {
            po[prop] = { seen: i }
          }
          break
        } /* else fallthrough */
      case 'number':
        po[prop] = prepare$number(o[prop]);
        break;
      case 'boolean':
      case 'string':
        po[prop] = prepare$primitive(o[prop], where + '.' + prop)
        break
      case 'undefined':
        po[prop] = prepare$undefined(o[prop])
        break
      default:
        throw new TypeError('Cannot serialize property ' + prop + ' which is a ' + typeof o[prop])
    }
  }

  return ret
}

/** Prepare an Array.  Sparse arrays and arrays with properties
 *  are supported, and represented reasonably efficiently, as are
 *  arrays of repeated values.
 *
 *  @param   seen   The current seen list for this marshal - things pointers point to
 *  @param   o      The array we are preparing
 *  @param   where  Human description of where we are in the object, for debugging purposes
 */
function prepare$Array (seen, o, where) {
  let pa = { arr: [] }
  let keys = Object.keys(o)
  let lastJson = NaN
  let json
  let lstTotal = 0

  for (let i = 0; i < o.length; i++) {
    if (!o.hasOwnProperty(i)) {
      break /* sparse array */
    }
    if (typeof o[i] !== 'object' && isPrimitiveLike(o[i])) {
      pa.arr.push(o[i])
    } else {
      pa.arr.push(prepare(seen, o[i], where + '.' + i))
    }

    json = JSON.stringify(pa.arr[pa.arr.length - 1])
    if (json === lastJson) {
      if (pa.arr[pa.arr.length - 2].lst) {
        pa.arr[pa.arr.length - 2].lst++
        pa.arr.length--
        lstTotal++
      } else {
        pa.arr[pa.arr.length - 1] = {lst: 1}
      }
    } else {
      lastJson = json
    }
  }

  if (keys.length !== o.length) {
    /* sparse array or array with own properties - difference between sparse entry and value=undefined preserved */
    for (let j = 0; j < keys.length; j++) {
      let key = keys[j]
      let idx = +key
      if (idx < i && pa.arr.hasOwnProperty(idx)) { /* test order for speed */
        continue
      }
      if (typeof idx === 'number' && o.hasOwnProperty(idx + 1)) {
        let island = { '@':idx, arr:[] }
        /* island of data inside sparse array */
        if (!pa.isl) {
          pa.isl = []
        }
        for (let k = idx; o.hasOwnProperty(k); k++) {
          island.arr.push(o[k])
        }
        j += island.arr.length - 1
        if (island.arr.length >= exports.scanArrayThreshold) {
          let tmp = prepare(seen, island.arr, where + '.' + 'isl@' + (j - island.arr.length))
          if (tmp.hasOwnProperty('arr')) {
            island.arr = tmp
          } else {
            pa.isl.push(island)
          }
        }
        pa.isl.push(island)
        continue
      }
      if (!pa.hasOwnProperty('ps')) {
        pa.ps = {}
      }
      if (typeof o[key] !== 'object' && isPrimitiveLike(o[key])) {
        pa.ps[key] = o[key]
      } else {
        pa.ps[key] = prepare(seen, o[key], where + '.' + key)
      }
    }
  }

  if (pa.arr.length + lstTotal !== o.length) {
    pa.len = o.length
  }
  return pa
}

/** Detect JavaScript strings which contain ill-formed UTF-16 sequences */
function notUnicode(s) {
  if (/[\ud800-\udbff][^\udc00-\udfff]/.test(s)) {
    return true /* high-surrogate without low-surrogate */
  }

  if (/[^\ud800-\udbff][\udc00-\udfff]/.test(s)) {
    return true /* low-surrogate without high-surrogate */
  }

  return false
}
/** Prepare an ArrayBuffer into UCS-2, returning null when we cannot guarantee
 *  that the UCS-2 is also composed of valid UTF-16 code points
 *
 *  @see unprepare$ArrayBuffer16
 */
function prepare$ArrayBuffer16 (o) {
  let ret = { ctr: ctors.indexOf(o.constructor) }
  let nWords = Math.floor(o.byteLength / 2)
  let s = ''

  if (ret.ctr === -1)
    ret.ctr = o.constructor.name

  if (littleEndian) {
    let ui16 = new Uint16Array(o.buffer, o.byteOffset, nWords)
    for (let i = 0; i < nWords; i++) {
      s += String.fromCharCode(ui16[i])
    }
  } else {
    let ui8 = new Uint8Array(o.buffer, o.byteOffset, o.byteLength)
    for (let i = 0; i < nWords; i++) {
      s += String.fromCharCode((ui8[0 + (2 * i)] << 8) + (ui8[1 + (2 * i)]))
    }
  }

  let manyZeroes = '\u0000\u0000\u0000\u0000'
  if (s.indexOf(manyZeroes) === -1) {
    ret.ab16 = s
  } else {
    /* String looks zero-busy: represent via islands of mostly non-zero (sparse string). */
    // let re = /([^\u0000]+/g
    let re = /([^\u0000]+(.{0,3}([^\u0000]|$))*)+/g
    let island

    ret.isl16 = []
    ret.len = o.byteLength
    while ((island = re.exec(s))) {
      ret.isl16.push({0: island[0].replace(/\u0000*$/, ''), '@': island.index})
    }
  }
  if ((2 * nWords) !== o.byteLength) {
    let ui8 = new Uint8Array(o.buffer, o.byteOffset + o.byteLength - 1, 1)
    ret.eb = ui8[0]
  }

  if (ret.ab16 && notUnicode(ret.ab16)) {
    return null
  } else {
    for (let i = 0; i < isl16.length; i++) {
      if (notUnicode(isl16[i])) {
        return null
      }
    }
  }
  return ret
}

/** Encode an ArrayBuffer (TypedArray) into a string composed solely of Latin-1 characters.
 *  Strings with many zeroes will be represented as sparse-string objects.
 */
function prepare$ArrayBuffer8 (o) {
  let ret = { ctr: ctors.indexOf(o.constructor) }

  if (ret.ctr === -1)
    ret.ctr = o.constructor.name

  const mss = _vm_fun_maxargs - 1
  let ui8 = new Uint8Array(o.buffer, o.byteOffset, o.byteLength)
  let segments = []
  let s

  for (let i=0; i < ui8.length / mss; i++) {
    segments.push(String.fromCharCode.apply(null, ui8.slice(i * mss, (i + 1) * mss)))
  }
  s = segments.join('')

  let manyZeroes = '\u0000\u0000\u0000\u0000\u0000\u0000\u0000\u0000'
  if (s.indexOf(manyZeroes) === -1) {
    ret.ab8 = s
  } else {
    /* String looks zero-busy: represent via islands of mostly non-zero (sparse string). */
    // let re = /([^\u0000]+/g
    let re = /([^\u0000]+(.{0,3}([^\u0000]|$))*)+/g
    let island

    ret.isl8 = []
    ret.len = o.byteLength
    while ((island = re.exec(s))) {
      ret.isl8.push({0: island[0].replace(/\u0000*$/, ''), '@': island.index})
    }
  }

  return ret
}

/** Encode an ArrayBuffer (TypedArray) into a string, trying multiple methods to determine
 *  optimimum size/performance.  The exports.tune variable affects the behaviour of this code this:
 *
 *  "speed" - only do naive encoding: floats get represented as byte-per-digit strings
 *  "size" - try the naive, ab8, and ab16 encodings; pick the smallest
 *  neither - try the naive encoding if under typedArrayPackThreshold and use if smaller than
 *            ab8; otherwise, use ab8
 */
function prepare$ArrayBuffer (o) {
  let naive, naiveJSONLen;
  let ab8, ab8JSONLen;
  let ab16, ab16JSONLen;

  if (exports.tune === "speed" || exports.tune === "size" || (o.byteLength < exports.typedArrayPackThreshold)) {
    naive = { ctr: ctors.indexOf(o.constructor), arg: Array.prototype.slice.call(o) }
    if (exports.tune === "speed") {
      return naive
    }
  }

  ab8 = prepare$ArrayBuffer8(o)
  if (exports.tune !== "size") {
    if (naive && naive.length < ab8.length) {
      return naive
    }
    return ab8
  }

  ab16 = prepare$ArrayBuffer16(o)
  naiveJSONLen = naive ? naive.length + 2 : Infinity
  ab8JSONLen = JSON.stringify(ab8).length;
  ab16JSONLen = ab16 ? JSON.stringify(ab16).length : Infinity

  if (ab16JSONLen < ab8JSONLen && ab16JSONLen < naiveJSONLen) {
    return ab16
  }
  if (naiveJSONLen < ab8JSONLen) {
    return naive
  }

  return ab8;
}

function prepare$RegExp (o) {
  return { ctr: ctors.indexOf(o.constructor), arg: o.toString().slice(1, -1) }
}

function prepare$boxedPrimitive (o) {
  return { ctr: ctors.indexOf(o.constructor), arg: o.toString() }
}

function prepare$number (n) {
  return Number.isFinite(n) ? n : { number: n + '' };
}
    
/* Store primitives and sort-of-primitives (like object literals) directly */
function prepare$primitive (primitive, where) {
  switch (typeof po) {
    case 'boolean':
    case 'number':
    case 'string':
      return primitive;
  }
  return { raw: primitive };
}

function prepare$undefined (o) {
  return { undefined: true }
}

/** Prepare a value for serialization
 *  @param      what any (supported) js value
 *  @returns    an object which can be serialized with json
 */
exports.marshal = function serialize$$marshal (what) {
  return {_serializeVerId: exports.serializeVerId, what: prepare([], what, 'top')}
}

/**
 * Prepare a value that is a Promise or contains a Promise for serialization.
 *
 * Removes cycles in objects to enable stringification using `JSON.stringify`.
 *
 * @param   {*} value A supported js value that can be marshalled
 * @returns {Promise<object>} An object which can be serialized with
 * `JSON.stringify`
 */
exports.marshalAsync = async function serialize$$marshalAsync(value, isRecursing = false) {
  /**
   * First, have marshal memoize returned an object graph with any instances of
   * Promise found during the marshal operation with { resolve: X }, where X is
   * an instance of Promise.
   *
   * If we're recursing, we're traversing a marshaled object and shouldn't
   * redundantly marshal a nested part of it.
   */
  let marshalledObject;
  if (!isRecursing) {
    marshalledObject = exports.marshal(value);
  } else {
    marshalledObject = value;
  }

  /**
   * Then, traverse the marshalled object, looking for these Promise memos
   * (resolve property). await the promise (X above) and replace it in the
   * marshaled object with the marshaled representation of the resolve value.
   */
  for (const key in marshalledObject) {
    if (!Object.hasOwnProperty.call(marshalledObject, key)) {
      continue;
    }

    switch (typeof marshalledObject[key]) {
      case 'object':
        if (marshalledObject[key] === null) {
          continue;
        }

        if (
          typeof marshalledObject[key].resolve !== 'undefined' &&
          marshalledObject[key].resolve instanceof Promise
        ) {
          marshalledObject[key].resolve = await exports.marshalAsync(
            await marshalledObject[key].resolve,
          );
        }

        /**
         * Recursively traverse the marshalled object
         *
         * Operating on the marshalled object graph means we know for certain we
         * are working on a directed acyclic graph (DAG); prepares's "seen"
         * array argument expresses cycles separately.
         */
        marshalledObject[key] = await exports.marshalAsync(
          marshalledObject[key],
          true,
        );
        break;
      default:
        break;
    }
  }

  return marshalledObject;
}

/** Turn a marshaled (prepared) value back into its original form
 *  @param      obj     a prepared object - the output of exports.marshal()
 *  @returns    object  an object resembling the object originally passed to exports.marshal()
 */
exports.unmarshal = function serialize$$unmarshal (obj) {
  if (!obj.hasOwnProperty('_serializeVerId')) {
    try {
      let str = JSON.stringify(obj)
      throw new Error('Invalid serialization format (' + str.slice(0, 20) + '\u22ef' + str.slice(-20) + ')')
    } catch (e) {
      throw new Error('Invalid serialization format')
    }
  }
  switch (obj._serializeVerId) {
    case 'v4':
    case 'v5':
    case 'v6':
    case 'v7':
      break
    default:
      throw new Error(`Cannot unmarshal ${obj._serializeVerId} objects - please update Kvin`)
  }
  return unprepare([], obj.what, 'top')
}

/** Serialize a value.
 *  @param      what    The value to serialize
 *  @returns    The JSON serialization of the prepared object representing what.
 */
exports.serialize = function serialize (what) {
  return JSON.stringify(exports.marshal(what))
}

/**
 * Serialize a value that is a Promise or contains Promises.
 *
 * @param   {*} value The value to serialize
 * @returns {Promise<string>} A JSON serialization representing the value
 */
exports.serializeAsync = async function serializeAsync(value) {
  return JSON.stringify(await exports.marshalAsync(value))
}

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
exports.deserialize = function deserialize (str) {
  return exports.unmarshal(JSON.parse(str))
}

exports.serializeVerId = 'v7'
  
if (_md) { module.declare = _md }
/* end of module */ })
