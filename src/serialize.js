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
 *  @author     Wes Garland, wes@page.ca
 *  @date       June 2018
 */

/* Set exports.makeFunctions = true to allow deserializer to make functions.
 * If the deserializer can make functions, it is equivalent to eval() from a
 * security POV.  Otherwise, the deserializer will turn functions into boxed
 * strings containing the function's source code, having a name property that
 * matches the original function.
 */
exports.makeFunctions = false
exports.serialize = serialize
exports.deserialize = deserialize

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
  if (po.hasOwnProperty('fnName')) {
    return unprepare$function(seen, po, position)
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

  if (!po.ctor.match(/^[A-Za-z_0-9$][A-Za-z_0-9$]*$/)) {
    throw new Error('Invalid constructor name: ' + po.ctr)
  }
  if (exports.constructorWhitelist && exports.constructorWhitelist.indexOf(po.ctr) === -1) {
    throw new Error('Whitelist does not include constructor ' + po.ctr)
  }
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

/** Take an arbitrary object and turn it into a 'prepared object'.
 *  A prepared object can always be represented with JSON.
 *
 *  @param      seen    An array objects we have already seen in this
 *                      object graph; used to track cycles.
 *  @param      o       The object that the prepared object reflects
 *  @returns            A prepared object
 */
function prepare (seen, o) {
  let i, ret
  let po = {}

  if ((i = seen.indexOf(o)) === -1) {
    seen.push(o)
  } else {
    return { seen: i }
  }

  /* Find objects which behave almost as primitives -- i.e. we
   * don't need to iterate over their properties in order to
   * serialize them.
   */
  if (o === null || Array.isArray(o) || typeof o.toJSON !== 'undefined') {
    return prepare$primitive(o)
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

  /* Iterate over the properties and prepare each in turn, recursing
   * with a depth-first traversal of the object graph. Iteration order
   * must match unprepare()!
   */
  for (let prop in o) {
    if (!o.hasOwnProperty(prop)) { continue }

    switch (typeof o[prop]) {
      case 'function':
      case 'object':
        if (o[prop] !== null && typeof o[prop].toJSON === 'undefined') {
          if (o[prop].constructor !== Object && o[prop].constructor.constructor !== Object) {
            throw new Error('Cannot serialize property ' + prop + ' - multiple inheritance is not supported')
          }
          if ((i = seen.indexOf(o[prop])) === -1) {
            po[prop] = prepare(seen, o[prop])
          } else {
            po[prop] = { seen: i }
          }
          break
        } /* else fallthrough */
      case 'number':
      case 'boolean':
      case 'string':
        po[prop] = prepare$primitive(o[prop])
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

function prepare$ArrayBuffer (o) {
  // alt impl: return { ctor: o.constructor.name, ctorArg: o.length, props: o }
  return { ctor: o.constructor.name, ctorArg: Array.prototype.slice.call(o) }
}

function prepare$RegExp (o) {
  return { ctor: o.constructor.name, ctorArg: o.toString().slice(1, -1) }
}

function prepare$boxedPrimitive (o) {
  return { ctor: o.constructor.name, ctorArg: o.toString() }
}

function prepare$primitive (o) {
  return { json: JSON.stringify(o) }
}

function prepare$undefined (o) {
  return { undefined: true }
}

/** Serialize a value.
 *  @param      what    The value to serialize
 *  @returns    The JSON serialization of the prepared object representing what.
 */
function serialize (what) {
  var prepared

  switch (typeof what) {
    case 'string':
    case 'number':
    case 'boolean':
      prepared = prepare$primitive(what)
      break
    case 'undefined':
      prepared = prepare$undefined(what)
      break
    default:
    case 'object':
      prepared = prepare([], what)
  }

  return JSON.stringify(prepared)
}

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
function deserialize (str) {
  return unprepare([], JSON.parse(str), 'top')
}
