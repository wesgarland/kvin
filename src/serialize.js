/**
 *  @file       serialize.js            A general-purpose library for marshaling and serialiazing
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
 *  @note       It is important to keep this module free of external dependencies, so that it
 *              can be easily injected into workers without module loaders during application
 *              bootstrapping / debugging.
 *
 *  @author     Wes Garland, wes@page.ca
 *  @date       June 2018
 */

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
  Function
];

/** Take a 'prepared object' (which can be represented by JSON) and turn it
 *  into an object which resembles the object it was created from.
 *
 *  @param      seen            An array objects we have already seen in this
 *                              object graph; used to track cycles.
 *  @param      po              A prepared object representing a value
 *  @param      position        A string respresenting our position within
 *                              the graph. Used only for error messages.
 *  @returns    the value encoded by po
 */
function unprepare (seen, po, position) {
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
  if (po.hasOwnProperty('ptv')) {
    return po.ptv
  }
  if (po.hasOwnProperty('fnName')) {
    return unprepare$function(seen, po, position)
  }
  if (po.hasOwnProperty('ab') || po.hasOwnProperty('isl')) {
    return unprepare$ArrayBuffer(po, position)
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

/**
 * arr:[] - Array of primitives of prepared objects
 * lst:N - repeat last element N times
 * ps:[] - property list
 */
function unprepare$Array (seen, po, position) {
  let a = []
  let last

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

  if (po.hasOwnProperty('ps')) {
    for (let prop in po.ps) {
      a[prop] = po.ps[prop]
    }
  }

  return a
}

/** The ab (array buffer) encoding encodes TypedArrays and related types by
 *  converting them to strings full of binary data in 16-bit words. Buffers
 *  with an odd number of bytes encode an extra byte 'eb' at the end by itself.
 *
 *  The isl (islands) encoding is almost the same, except that it encodes only
 *  sequences of mostly-non-zero sections of the string.
 */
function unprepare$ArrayBuffer (po, position) {
  let i16, i8, words
  let bytes
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = ctors[po.ctr]
  }

  if (po.hasOwnProperty('ab')) {
    bytes = po.ab.length * 2
    if (po.hasOwnProperty('eb')) {
      bytes++
    }
  } else {
    bytes = po.len
  }

  words = Math.floor(bytes / 2) + (bytes % 2)
  i16 = new Int16Array(words)
  if (po.hasOwnProperty('ab')) {
    for (let i = 0; i < po.ab.length; i++) {
      i16[i] = po.ab.charCodeAt(i)
    }
  } else {
    for (let j = 0; j < po.isl.length; j++) {
      for (let i = 0; i < po.isl[j][0].length; i++) {
        i16[po.isl[j]['@'] + i] = po.isl[j][0].charCodeAt(i)
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
  if (o === null || (typeof o === 'object' && typeof o.toJSON !== 'undefined') ||
      typeof o === 'string' || typeof o === 'boolean' || typeof o === 'number') {
    return true
  }

  if (!Array.isArray(o)) {
    return false
  }

  for (let i = 0; i < o.length; i++) {
    if (!isPrimitiveLike(o[i])) {
      return false
    }
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
    return prepare$primitive(o, where)
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
        if (o[prop] !== null && typeof o[prop].toJSON === 'undefined') {
          if (typeof o[prop].constructor !== 'undefined' && o[prop].constructor !== Object && o[prop].constructor.constructor !== Object &&
              o[prop].constructor !== Function && o[prop].constructor.constructor !== Function) {
            throw new Error('Cannot serialize property ' + prop + ' - multiple inheritance is not supported')
          }
          if ((i = seen.indexOf(o[prop])) === -1) {
            po[prop] = prepare(seen, o[prop], where + '.' + prop)
          } else {
            po[prop] = { seen: i }
          }
          break
        } /* else fallthrough */
      case 'number':
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

  ret = { ctr: ctors.indexOf(Object), ps: po }
  if (typeof o === 'function') {
    ret.fnName = o.name
    ret.arg = o.toString()
  }
  return ret
}

/* Prepare an Array.  Sparse arrays and arrays with properties
 * are supported, and represented reasonably efficiently.
 */
function prepare$Array (seen, o, where) {
  let pa = { arr: [] }
  let keys = Object.keys(o)
  let lastJson = NaN
  let json
  let i

  for (i = 0; i < o.length; i++) {
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
      } else {
        pa.arr[pa.arr.length - 1] = {lst: 1}
      }
    } else {
      lastJson = json
    }
  }

  if (keys.length !== o.length) {
    /* sparse array or array with own properties */
    pa.ps = {}
    for (let j = 0; j < keys.length; j++) {
      if (typeof keys[j] === 'number' && keys[j] <= i) { continue }
      if (typeof o[keys[j]] !== 'object' && isPrimitiveLike(o[keys[j]])) {
        pa.ps[keys[i]] = o[keys[i]]
      } else {
        pa.ps[keys[j]] = prepare(seen, o[keys[j]], where + '.' + keys[j])
      }
    }
  }

  return pa
}

/** @seen unprepare$ArrayBuffer */
function prepare$ArrayBuffer (o) {
  if (o.byteLength < exports.typedArrayPackThreshold) { /* Small enough to use fast code */
    // alt impl: return { ctr: o.constructor.name, arg: o.length, ps: o }
    return { ctr: ctors.indexOf(o.constructor), arg: Array.prototype.slice.call(o) }
  }

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
    ret.ab = s
  } else {
    /* String looks zero-busy: represent via islands of mostly non-zero (sparse string). */
    // let re = /([^\u0000]+/g
    let re = /([^\u0000]+(.{0,3}([^\u0000]|$))*)+/g
    let island

    ret.isl = []
    ret.len = o.byteLength
    while ((island = re.exec(s))) {
      ret.isl.push({0: island[0].replace(/\u0000*$/, ''), '@': island.index})
    }
  }
  if ((2 * nWords) !== o.byteLength) {
    let ui8 = new Uint8Array(o.buffer, o.byteOffset + o.byteLength - 1, 1)
    ret.eb = ui8[0]
  }

  return ret
}

function prepare$RegExp (o) {
  return { ctr: ctors.indexOf(o.constructor), arg: o.toString().slice(1, -1) }
}

function prepare$boxedPrimitive (o) {
  return { ctr: ctors.indexOf(o.constructor), arg: o.toString() }
}

/* Store primitives an sort-of-primitives (like object literals) directly */
function prepare$primitive (primitive, where) {
  try {
    return { ptv: primitive }
  } catch (e) {
    let e2 = new (e.constructor)(e.message + ' for ' + where)
    throw e2
  }
}

function prepare$undefined (o) {
  return { undefined: true }
}

/** Prepare a value for serialization
 *  @param      what any (supported) js value
 *  @returns    an object which can be serialized with json
 */
exports.marshal = function serialize$$marshal (what) {
  return {_serializeVerId: 'v3', what: prepare([], what, 'top')}
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
    case 'v3':
      break
    default:
      throw new Error('Invalid serialization version')
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

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
exports.deserialize = function deserialize (str) {
  return exports.unmarshal(JSON.parse(str))
}

if (_md) { module.declare = _md }
/* end of module */ })
