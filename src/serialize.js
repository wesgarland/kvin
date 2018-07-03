/**
 *  @file       serialize.js            A general-purpose library for serializing/deserializing
 *                                      ES objects.  This library is a functional superset of,
 *                                      and relies on JSON as much as possible for speed, adding:
 *                                      - Typed Arrays
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
 *                                      The basic implementation strategy is to create an intermediate
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

/* This prologue allows a module.declare module's exports to be loaded with eval(readFileSync(filename)) */
var module, _md;
if (typeof module === "undefined" || typeof module.declare === "undefined") {
  _md = (typeof module === "object") ? module.declare : null
  if (typeof module !== "object")
    module = { exports: {} };
    module.declare = function moduleUnWrapper(deps, factory) {
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
exports.typedArrayPackThreshold = 4

const littleEndian = (function () {
  let ui16 = new Uint16Array(1)
  let ui8

  ui16[0] = 0xffef
  ui8 = new Uint8Array(ui16.buffer)

  if (ui8[0] === 0x0ff) {
    console.log('Detected big-endian platform')
    return false
  }

  return true
})()
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
  if (po.hasOwnProperty('ctor') && !po.ctor.match(/^[A-Za-z_0-9$][A-Za-z_0-9$]*$/)) {
    if (exports.constructorWhitelist && exports.constructorWhitelist.indexOf(po.ctr) === -1) {
      throw new Error('Whitelist does not include constructor ' + po.ctr)
    }
    throw new Error('Invalid constructor name: ' + po.ctr)
  }
  if (po.hasOwnProperty('fnName')) {
    return unprepare$function(seen, po, position)
  }
  if (po.hasOwnProperty('arrbuf')) {
    return unprepare$ArrayBuffer(po)
  }
  if (po.hasOwnProperty('ctor')) {
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
  throw new TypeError('Invalid serialization format at ' + position)
}

function unprepare$object (seen, po, position) {
  let o

  if (po.hasOwnProperty('ctorArg')) {
    o = new (eval(po.ctor))(po.ctorArg) // eslint-disable-line
  } else {
    o = new (eval(po.ctor))() // eslint-disable-line
  }

  seen.push(o)

  if (po.hasOwnProperty('props')) {
    for (let prop in po.props) {
      if (po.props.hasOwnProperty(prop)) {
        o[prop] = unprepare(seen, po.props[prop], position + '.' + prop)
      }
    }
  }

  return o
}

function unprepare$function (seen, po, position) {
  let obj, fn
  let fnName = po.fnName

  /* A function is basically a callable object */
  po.ctor = 'Object'
  delete po.fnName
  obj = unprepare(seen, po, position)

  if (!exports.makeFunctions) {
    obj.name = fnName
    return obj
  }

  fn = (new Function('return ' + po.ctorArg))()  // eslint-disable-line
  if (po.hasOwnProperty('props')) {
    for (let prop in po.props) {
      fn[prop] = obj[prop]
    }
  }

  return fn
}

/** The arrbuf encoding encodes TypedArrays and related types by converting
 *  them to strings full of binary data in 16-bit words. Buffers with an
 *  odd number of bytes encode an extraByte at the end by itself.
 */
function unprepare$ArrayBuffer (po) {
  let i16, i8, words
  let bytes = po.arrbuf.length * 2

  if (po.hasOwnProperty('extraByte')) {
    bytes++
  }
  words = Math.floor(bytes / 2) + (bytes % 2)
  i16 = new Int16Array(words)
  for (let i = 0; i < po.arrbuf.length; i++) {
    i16[i] = po.arrbuf.charCodeAt(i)
  }
  i8 = new Int8Array(i16.buffer, 0, bytes)
  if (po.hasOwnProperty('extraByte')) {
    i8[i8.byteLength - 1] = po.extraByte.charCodeAt(0)
  }

  if (!littleEndian) {
    for (let i = 0; i < i8.length; i += 2) {
      i8[(i * 2) + 0] = i8[(i * 2) + 0] ^ i8[(i * 2) + 1]
      i8[(i * 2) + 1] = i8[(i * 2) + 1] ^ i8[(i * 2) + 0]
      i8[(i * 2) + 0] = i8[(i * 2) + 0] ^ i8[(i * 2) + 1]
    }
  }

  return new (eval(po.ctor))(i8.buffer) // eslint-disable-line
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

  if ((i = seen.indexOf(o)) === -1) {
    seen.push(o)
  } else {
    return { seen: i }
  }

  /* Find primitives and objects which behave almost as primitives -- i.e. 
   * we don't need to iterate over their properties in order to
   * serialize them. Treat these as terminals.
   */
  if (o === null || Array.isArray(o) || (typeof o === "object" && typeof o.toJSON !== 'undefined')
      || typeof o === "string" || typeof o === "boolean" || typeof o === "number") {
    return prepare$primitive(o, where)
  }
  if (typeof o === 'undefined') {
    return prepare$undefined(o)
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
          if (typeof o[prop].constructor !== "undefined" && o[prop].constructor !== Object && o[prop].constructor.constructor !== Object &&
              o[prop].constructor !== Function && o[prop].constructor.constructor !== Function) {
            throw new Error('Cannot serialize property ' + prop + ' - multiple inheritance is not supported')
          }
          if ((i = seen.indexOf(o[prop])) === -1) {
            po[prop] = prepare(seen, o[prop], where + "." + prop)
          } else {
            po[prop] = { seen: i }
          }
          break
        } /* else fallthrough */
      case 'number':
      case 'boolean':
      case 'string':
        po[prop] = prepare$primitive(o[prop], where + "." + prop)
        break
      case 'undefined':
        po[prop] = prepare$undefined(o[prop])
        break
      default:
        throw new TypeError('Cannot serialize property ' + prop + ' which is a ' + typeof o[prop])
    }
  }

  ret = { ctor: 'Object', props: po }
  if (typeof o === 'function') {
    ret.fnName = o.name
    ret.ctorArg = o.toString()
  }
  return ret
}

/** @seen unprepare$ArrayBuffer */
function prepare$ArrayBuffer (o) {
  if (o.byteLength < exports.typedArrayPackThreshold) { /* Small enough to use fast code */
    // alt impl: return { ctor: o.constructor.name, ctorArg: o.length, props: o }
    return { ctor: o.constructor.name, ctorArg: Array.prototype.slice.call(o) }
  }
  let ret = { ctor: o.constructor.name }
  let nWords = Math.floor(o.byteLength / 2)
  let s = ''

  if (littleEndian) {
    let ui16 = new Uint16Array(o.buffer, 0, nWords)
    for (let i = 0; i < nWords; i++) {
      s += String.fromCharCode(ui16[i])
    }
  } else {
    let ui8 = new Uint8Array(o.buffer)
    for (let i = 0; i < nWords; i++) {
      s += String.fromCharCode((ui8[0 + (2 * i)] << 8) + (ui8[1 + (2 * i)]))
    }
  }

  ret.arrbuf = s
  if ((2 * nWords) !== o.byteLength) {
    let ui8 = new Uint8Array(o.buffer, o.buffer.byteLength - 1, 1)
    ret.extraByte = ui8[0]
  }

  return ret
}

function prepare$RegExp (o) {
  return { ctor: o.constructor.name, ctorArg: o.toString().slice(1, -1) }
}

function prepare$boxedPrimitive (o) {
  return { ctor: o.constructor.name, ctorArg: o.toString() }
}

function prepare$primitive (o, where) {
  try {
    return { json: JSON.stringify(o) }
  } catch (e) {
    let e2 = new (e.constructor)(e.message + " for " + where)
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
exports.prepare = function serialize$$prepare (what) {
  return prepare([], what, 'top');
}

/** Turn a prepared value back into its original form 
 *  @param      obj     a prepared object 
 *  @returns    object  an object resembling the object originally passed to exports.prepare()
 */
exports.unprepare = function serialize$$unprepare (obj) {
  return unprepare([], obj, 'top')
}

/** Serialize a value.
 *  @param      what    The value to serialize
 *  @returns    The JSON serialization of the prepared object representing what.
 */
exports.serialize = function serialize (what) {
  return JSON.stringify(exports.prepare(what))
}

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
exports.deserialize = function deserialize (str) {
  return exports.unprepare(JSON.parse(str))
}

if (_md)
  module.declare = _md;
/* end of module */ })
