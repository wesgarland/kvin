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
 *                                      - opt-in list of supported constructors (kvin.constructorAllowList)
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

{/* This prologue allows a CJS2 module's exports to be loaded with eval(readFileSync(filename)) */
  var module;
  let moduleSystemType;
  let realModule = module;
  
  if (typeof __webpack_require__ !== 'undefined')
    moduleSystemType = 'webpack';
  else if (typeof module !== 'undefined' && typeof module.declare !== 'undefined')
    moduleSystemType = 'cjs2';
  else if (typeof module !== 'undefined' && typeof require === 'function' && typeof exports !== 'undefined' && module.exports === exports)
    moduleSystemType = 'nodejs';
  else if (typeof exports !== 'undefined' && typeof require === 'function')
    moduleSystemType = 'cjs1';
  else
    moduleSystemType = 'none';

  module = Object.assign({}, realModule);

  if (moduleSystemType === 'nodejs' || moduleSystemType === 'webpack' || moduleSystemType === 'cjs1') {
    module.declare = function kvin$$cjs1$$moduleDeclare(deps, factory) {
      factory(null, exports, null);
      module = realModule;
      return exports;
    };
  } else if (moduleSystemType === 'cjs2') {
    module = realModule;
  } else if (moduleSystemType === 'none') {
    module.declare = function kvin$$cjs1$$moduleDeclare(deps, factory) {
      let exports = {};
      factory(null, exports, null);
      module = realModule;

      if (typeof window === 'object')
        window.KVIN = exports;
      if (typeof globalThis === 'object')
        globalThis.KVIN = exports;

      return exports;
    };
  }
/* Now initialize the module by invoking module.declare per CommonJS Modules/2.0-draft8 */
  
/* eslint-disable indent */ module.declare([], function (require, exports, module) {

/** 
 * @constructor to create an alternate KVIN context. This allows us to recogonize instance of
 *              the standard classes from a different JS context or have different tuning parameters.   
 * @param ctors list or object of standard constructors
 */
function KVIN(ctors)
{
  // We always need to initialize the standardObjects. It is used for comparisons for primitive types etc
  this.standardObjects = {};
  for (let ctor of KVIN.prototype.ctors) {
    this.standardObjects[ctor.name] = ctor;
  }

  this.ctors = [].concat(KVIN.prototype.ctors);
  
  if (!ctors)
    return;

  if (Array.isArray(ctors))
  {
    for (let ctor of ctors)
    {
      this[ctor.name] = ctor
      for (let i=0; i < this.ctors.length; i++)
      {
        if (this.ctors[i].name === ctor.name)
          this.ctors[i] = ctor;
      }
    }
  }
  else
  {
    for (let entry of Object.entries(ctors))
    {
      for (let i=0; i < this.ctors.length; i++)
      {
        let [ name, ctor ] = entry; 
        if (this.ctors[i].name === name)
          this.ctors[i] = ctor;
          this.standardObjects[name] = ctor;
      }
    }
  }
}
/*
 * Set exports.makeFunctions = true to allow deserializer to make functions.
 * If the deserializer can make functions, it is equivalent to eval() from a
 * security POV.  Otherwise, the deserializer will turn functions into boxed
 * strings containing the function's source code, having a name property that
 * matches the original function.
 */
KVIN.prototype.makeFunctions = false

/* More bytes in a TypedArray than typedArrayPackThreshold will trigger
 * the code to prepare these into strings rather than arrays.
 */
KVIN.prototype.typedArrayPackThreshold = 8

/* Arrays of primitives which are >= the threshold in length are scrutinized
 * for further optimization, e.g. by run-length encoding
 */
KVIN.prototype.scanArrayThreshold = 8


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
    console.error('KVIN: Detected big-endian platform')
    return false
  }

  return true
})()

/** Pre-defined constructors, used to compact payload */
KVIN.prototype.ctors = [
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
  Error,
  Promise,
];
if (typeof URL !== 'undefined'){
  KVIN.prototype.ctors.push(URL)
}

KVIN.prototype.userCtors = {}; /**< name: implementation for user-defined constructors that are not props of global */

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
KVIN.prototype.unprepare = function unprepare (seen, po, position) {
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
        if (this.constructorAllowlist && this.constructorAllowlist.indexOf(po.ctr) === -1) {
          throw new Error('Allowlist does not include constructor ' + po.ctr)
        }
        throw new Error('Invalid constructor name: ' + po.ctr)
      }
      break
    case 'number':
      if (!(po.ctr >= 0 && po.ctr < this.ctors.length)) {
        throw new Error('Invalid constructor number: ' + po.ctr)
      }
      break
    default:
      throw new Error('Invalid constructor label type ' + typeof po.ctr)
    }
  }
  if (po.hasOwnProperty('raw')) {
    if (typeof po.raw === 'object' && po.raw !== null && !Array.isArray(po.raw))
    {
      if (!po.used)
        po.used = true;
      else
        return JSON.parse(JSON.stringify(po.raw));
      return Object.assign(new this.standardObjects.Object(), po.raw);
    }
    return po.raw;
  }
  if (po.hasOwnProperty('ptv')) {
    return po.ptv; /* deprecated: only created by v3-6 */
  }
  if (po.hasOwnProperty('number')) {
    return unprepare$number(po.number);
  }
  if (po.hasOwnProperty('bigint')) {
    return unprepare$bigint(po.bigint);
  }
  if (po.hasOwnProperty('fnName')) {
    return this.unprepare$function(seen, po, position)
  }
  if (po.hasOwnProperty('ab16') || po.hasOwnProperty('isl16')) {
    return this.unprepare$ArrayBuffer16(seen, po, position)
  }
  if (po.hasOwnProperty('ab8') || po.hasOwnProperty('isl8')) {
    return this.unprepare$ArrayBuffer8(seen, po, position)
  }
  if (po.hasOwnProperty('arr')) {
    return this.unprepare$Array(seen, po, position)
  }
  if (po.hasOwnProperty('ctr')) {
    return this.unprepare$object(seen, po, position)
  }
  if (po.hasOwnProperty('json')) {
    return JSON.parse(po.json)
  }
  if (po.hasOwnProperty('undefined')) {
    return undefined
  }

  if (Object.hasOwnProperty.call(po, 'resolve')) {
    // Unprepare a Promise by assuming po.resolve is a marshalled value.
    const promise = Promise.resolve(this.unmarshal(po.resolve));
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

KVIN.prototype.unprepare$object = function unprepare$object (seen, po, position) {
  let o
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    if (this.userCtors.hasOwnProperty(po.ctr))
      constructor = this.userCtors[po.ctr];
    else 
      constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = this.ctors[po.ctr]
  }

  if (po.hasOwnProperty('arg')) {
    o = new constructor(po.arg)
  } else {
    o = new constructor() // eslint-disable-line
  }

  if (po.ctr === 'Error')
  {
    delete o.stack;
    delete o.lineNumber;
    delete o.fileName;
  }
  
  seen.push(o)

  if (po.hasOwnProperty('ps')) {
    for (let prop in po.ps) {
      if (po.ps.hasOwnProperty(prop)) {
        o[prop] = this.unprepare(seen, po.ps[prop], position + '.' + prop)
      }
    }
  }

  return o
}

KVIN.prototype.unprepare$function = function unprepare$function (seen, po, position) {
  let obj, fn
  let fnName = po.fnName

  /* A function is basically a callable object */
  po.ctr = this.ctors.indexOf(Object)
  delete po.fnName
  obj = this.unprepare(seen, po, position)

  if (!this.makeFunctions) {
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

function unprepare$bigint(arg) {
  return BigInt(arg);
}

function unprepare$number(arg) {
  return parseFloat(arg);
}
  
/**
 * arr:[] - Array of primitives of prepared objects
 * lst:N - repeat last element N times
 * ps:[] - property list
 */
KVIN.prototype.unprepare$Array = function unprepare$Array (seen, po, position) {
  let a = []
  let last

  seen.push(a)

  for (let i = 0; i < po.arr.length; i++) {
    if (typeof po.arr[i] === 'object') {
      if (po.arr[i].lst) {
        for (let j = 0; j < po.arr[i].lst; j++) {
          a.push(this.unprepare(seen, last, position + '.' + (i + j)))
        }
        continue
      }
      a.push(this.unprepare(seen, po.arr[i], position + '.' + i))
      last = po.arr[i]
    } else {
      a.push(po.arr[i])
      last = prepare$primitive(a[a.length-1], 'unprepare$Array')
    }
  }

  if (po.hasOwnProperty('isl')) {
    for (let prop in po.isl) {
      let island = po.isl[prop]
      let els = Array.isArray(island.arr) ? island.arr : this.unprepare$Array(seen, island.arr, [ position, 'isl', prop ].join('.'))

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
        a[prop] = this.unprepare(seen, po.ps[prop], position + '.' + prop)
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
KVIN.prototype.unprepare$ArrayBuffer8 = function unprepare$ArrayBuffer8 (seen, po, position) {
  let i8
  let bytes
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = this.ctors[po.ctr]
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
  let o = new constructor(i8.buffer, i8.byteOffset) // eslint-disable-line;
  seen.push(o)
  return o;
}

/** The ab16 (array buffer 16 bit) encoding encodes TypedArrays and related types by
 *  converting them to strings full of binary data in 16-bit words. Buffers
 *  with an odd number of bytes encode an extra byte 'eb' at the end by itself.
 *
 *  The isl16 (islands) encoding is almost the same, except that it encodes only
 *  sequences of mostly-non-zero sections of the string.
 */
 KVIN.prototype.unprepare$ArrayBuffer16 = function unprepare$ArrayBuffer16 (seen, po, position) {
  let i16, i8, words
  let bytes
  let constructor;

  if (typeof po.ctr === 'string' && !po.ctr.match(/^[1-9][0-9]*$/)) {
    constructor = eval(po.ctr) /* pre-validated! */ // eslint-disable-line
  } else {
    constructor = this.ctors[po.ctr]
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
  let o = new constructor(i8.buffer, i8.byteOffset) // eslint-disable-line
  seen.push(o)
  return o
}

/* Primitives and primitive-like objects do not have any special
 * marshaling requirements -- specifically, we don't need to
 * iterate over their properties in order to serialize them; we
 * can let JSON.stringify() do any heavy lifting.
 */
KVIN.prototype.isPrimitiveLike = function isPrimitiveLike (o, seen) {
  if (o === null || typeof o === 'string' || typeof o === 'boolean')
    return true;

  if (typeof o === 'number')
    return Number.isFinite(o);

  if (typeof o !== 'object')
    return false;
 
  if (o.constructor === this.standardObjects.Object && Object.keys(o).length === 0)
    return true;

  if (o.constructor === this.standardObjects.Array && o.length === 0 && Object.keys(o).length === 0)
    return true;

  if (o.constructor !== this.standardObjects.Object && o.constructor !== this.standardObjects.Array)
    return false;

  if (Array.isArray(o)) {
    if (Object.keys(o).length !== o.length) {
      return false /* sparse array or named props */
    }
  }

  seen = seen.concat(o);
  for (let prop in o) {
    if (!o.hasOwnProperty(prop))
      return false;
    if (seen.indexOf(o[prop]) !== -1)
      return false; 
    if (!this.isPrimitiveLike(o[prop], seen))
      return false;
  }

  return true
}

/**
 * Serialize an instance of Error, preserving standard-ish non-enumerable properties 
 */     
function prepare$Error(o)
{
  let ret = {
    ctr: 'Error',
    ps: {},
    arg: o.message
  };

  for (let prop of ['code', 'stack', 'lineNumber', 'fileName'])
    if (o.hasOwnProperty(prop))
      ret.ps[prop] = o[prop];
  for (let prop in o)
    if (o.hasOwnProperty(prop))
      ret.ps[prop] = o[prop];

  return ret;
}
  
/** Take an arbitrary object and turn it into a 'prepared object'.
 *  A prepared object can always be represented with JSON.
 *
 *  @param      seen    An array objects we have already seen in this
 *                      object graph; used to track cycles.
 *  @param      o       The object that the prepared object reflects
 *  @returns            A prepared object
 */
KVIN.prototype.prepare =  function prepare (seen, o, where) {
  let i, ret
  let po = {}

  if (typeof o === 'number') {
    return prepare$number(o)
  }
  if (typeof o === 'bigint') {
    return prepare$bigint(o)
  }
  if (this.isPrimitiveLike(o, seen)) {
    if (!Array.isArray(o) || o.length < this.scanArrayThreshold)
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
    return this.prepare$Array(seen, o, where)
  }
  if (ArrayBuffer.isView(o)) {
    return this.prepare$ArrayBuffer(o)
  }
  if (o.constructor === String || o.constructor === Number || o.constructor === Boolean) {
    return this.prepare$boxedPrimitive(o)
  }
  if (o.constructor === RegExp) {
    return this.prepare$RegExp(o)
  }

  if (o instanceof Promise || o instanceof this.standardObjects.Promise) {
    /**
     * Let the caller replace the `resolve` property with its marshalled
     * resolved value.
     */
    return { resolve: o };
  }

  if (o instanceof Error || o instanceof this.standardObjects.Error) {
    /* special-case Error to get non-enumerable properties */
    return prepare$Error(o);
  }

  if (typeof o.constructor === 'undefined') {
    console.warn('KVIN Warning: ' + where + ' is missing .constructor -- skipping')
    return prepare$undefined(o)
  }

  ret = { ctr: this.ctors.indexOf(o.constructor), ps: po }
  if (ret.ctr === -1) {
    /**
     * If the constructor is `Object` from another context, the indexOf check
     * would fail. So if the name of `o`'s constructor matches one of the valid
     * constructors, use the index from the mapped array to get the proper
     * constructor index.
     */
    const constructorNames = this.ctors.map((ctor) => ctor.name);
    const ctrIndex = constructorNames.indexOf(o.constructor.name);
    if (ctrIndex !== -1) {
      ret.ctr = ctrIndex;
      /**
       * Fix the `o`'s constructor to match its constructor in the current
       * context so that later equality/instanceof checks don't fail.
       */
      o.constructor = this.ctors[ctrIndex];
    } else {
      ret.ctr = o.constructor.name || this.ctors.indexOf(Object)
    }
  }

  if (typeof o === 'function') {
    ret.fnName = o.name
  }

  if (typeof o.toJSON === 'function') {
    ret.arg = o.toJSON()
  } else {
    if (o.constructor !== this.standardObjects.Object)
      ret.arg = o.toString()
  }

  if (typeof o.hasOwnProperty === 'undefined') {
    console.warn('KVIN Warning: ' + where + ' is missing .hasOwnProperty -- skipping')
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
              && o[prop].constructor !== this.standardObjects.Object && o[prop].constructor.constructor !== this.standardObjects.Object
              && o[prop].constructor !== this.standardObjects.Function && o[prop].constructor.constructor !== this.standardObjects.Function
              && o[prop].constructor !== this.standardObjects.Function && o[prop].constructor.constructor.name !== "Function" /* vm context issue /wg aug 2020 */
            ) {
            throw new Error(`Cannot serialize property ${where}.${prop} - multiple inheritance is not supported.`);
          }
          if ((i = seen.indexOf(o[prop])) === -1) {
            po[prop] = this.prepare(seen, o[prop], where + '.' + prop)
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
 KVIN.prototype.prepare$Array = function prepare$Array (seen, o, where) {
  let pa = { arr: [] }
  let keys = Object.keys(o)
  let lastJson = NaN
  let json
  let lstTotal = 0

  for (let i = 0; i < o.length; i++) {
    if (!o.hasOwnProperty(i)) {
      break /* sparse array */
    }
    if (typeof o[i] !== 'object' && this.isPrimitiveLike(o[i], seen)) {
      pa.arr.push(o[i])
    } else {
      pa.arr.push(this.prepare(seen, o[i], where + '.' + i))
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
      if (idx < j && pa.arr.hasOwnProperty(idx)) { /* test order for speed */
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
        if (island.arr.length >= this.scanArrayThreshold) {
          let tmp = this.prepare(seen, island.arr, where + '.' + 'isl@' + (j - island.arr.length))
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
      if (typeof o[key] !== 'object' && this.isPrimitiveLike(o[key], seen)) {
        pa.ps[key] = o[key]
      } else {
        pa.ps[key] = this.prepare(seen, o[key], where + '.' + key)
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
KVIN.prototype.prepare$ArrayBuffer16 = function prepare$ArrayBuffer16 (o) {
  let ret = { ctr: this.ctors.indexOf(o.constructor) }
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
  } else  if (ret.isl16) {
    for (let i = 0; i < ret.isl16.length; i++) {
      if (notUnicode(ret.isl16[i])) {
        return null
      }
    }
  }
  return ret
}

/** Encode an ArrayBuffer (TypedArray) into a string composed solely of Latin-1 characters.
 *  Strings with many zeroes will be represented as sparse-string objects.
 */
KVIN.prototype.prepare$ArrayBuffer8 = function prepare$ArrayBuffer8 (o) {
  let ret = { ctr: this.ctors.indexOf(o.constructor) }

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
 *  optimimum size/performance.  The this.tune variable affects the behaviour of this code this:
 *
 *  "speed" - only do naive encoding: floats get represented as byte-per-digit strings
 *  "size" - try the naive, ab8, and ab16 encodings; pick the smallest
 *  neither - try the naive encoding if under typedArrayPackThreshold and use if smaller than
 *            ab8; otherwise, use ab8
 */
KVIN.prototype.prepare$ArrayBuffer = function prepare$ArrayBuffer (o) {
  let naive, naiveJSONLen;
  let ab8, ab8JSONLen;
  let ab16, ab16JSONLen;

  if (this.tune === "speed" || this.tune === "size" || (o.byteLength < this.typedArrayPackThreshold)) {
    naive = { ctr: this.ctors.indexOf(o.constructor), arg: Array.prototype.slice.call(o) }
    if (this.tune === "speed") {
      return naive
    }
  }

  naiveJSONLen = naive ? JSON.stringify(naive).length : Infinity

  ab8 = this.prepare$ArrayBuffer8(o)
  if (this.tune !== "size") {
    if (naive && naive.length < ab8.length) {
      return naive
    }
    return ab8
  }

  ab16 = this.prepare$ArrayBuffer16(o)
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

KVIN.prototype.prepare$RegExp = function prepare$RegExp (o) {
  return { ctr: this.ctors.indexOf(o.constructor), arg: o.toString().slice(1, -1) }
}

KVIN.prototype.prepare$boxedPrimitive = function prepare$boxedPrimitive (o) {
  return { ctr: this.ctors.indexOf(o.constructor), arg: o.toString() }
}

function prepare$bigint (n) {
  return { bigint: n.toString() }
}

function prepare$number (n) {
  if (!Number.isFinite(n))
    return { number: n + '' };

  if (1/n === -Infinity)
    return { json: "-0" };

  return n;
}
    
/* Store primitives and sort-of-primitives (like object literals) directly */
function prepare$primitive (primitive, where) {
  switch (typeof po) {
    case 'boolean':
    case 'number': /* not all cases, see prepare$number */
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
KVIN.prototype.marshal = function serialize$$marshal (what) {
  return {_serializeVerId: this.serializeVerId, what: this.prepare([], what, 'top')}
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
KVIN.prototype.marshalAsync = async function serialize$$marshalAsync(value, isRecursing = false) {
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
    marshalledObject = this.marshal(value);
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
          marshalledObject[key].resolve = await this.marshalAsync(
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
        marshalledObject[key] = await this.marshalAsync(
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
 *  @param      obj     a prepared object - the output of this.marshal()
 *  @returns    object  an object resembling the object originally passed to this.marshal()
 */
KVIN.prototype.unmarshal = function serialize$$unmarshal (obj) {
  if (typeof obj !== 'object' || obj === null) {
    throw new Error(`Cannot unmarshal type ${typeof obj} or null.`)
  }
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
  return this.unprepare([], obj.what, 'top')
}

/** Serialize a value.
 *  @param      what    The value to serialize
 *  @returns    The JSON serialization of the prepared object representing what.
 */
KVIN.prototype.serialize = function serialize (what) {
  return JSON.stringify(this.marshal(what))
}

/**
 * Serialize a value that is a Promise or contains Promises.
 *
 * @param   {*} value The value to serialize
 * @returns {Promise<string>} A JSON serialization representing the value
 */
KVIN.prototype.serializeAsync = async function serializeAsync(value) {
  return JSON.stringify(await this.marshalAsync(value))
}

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
KVIN.prototype.deserialize = function deserialize (str) {
  if (typeof str !== 'string') {
    throw new Error(`Cannot deserialize type ${typeof str}`)
  }
  return this.unmarshal(JSON.parse(str))
}

KVIN.prototype.serializeVerId = 'v7'
  
/* JSON-like interface */
KVIN.prototype.parse = KVIN.prototype.deserialize;  
KVIN.prototype.stringify = KVIN.prototype.serialize;
KVIN.prototype.stringifyAsync = KVIN.prototype.serializeAsync;

exports.base_kvin = new KVIN();

for (let prop in exports.base_kvin)
{
  if (typeof exports.base_kvin[prop] === 'function')
    exports[prop] = exports.base_kvin[prop].bind(exports);
  else {
    exports[prop] = exports.base_kvin[prop]
  }
}

exports.KVIN = KVIN;
/* end of module */ })}
