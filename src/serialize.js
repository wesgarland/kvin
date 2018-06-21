/**
 *  @file       serialize.js            A general-purpose library for serializing/deserializing
 *                                      ES objects.  This library relies on JSON as much as possible
 *                                      for speed, but also supports:
 *                                      - undefined
 *                                      - Typed Arrays
 *                                      - Regular Expressions
 *                                      - Object graphs with cycles
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
 *                                      object insertion order.  This could cause problems with objects
 *                                      with cycles in less-common interpreters, such as Rhino and (especially) 
 *                                      the NJS ES3 platform.
 *
 *  @author     Wes Garland, wes@page.ca
 *  @date       June 2018
 */

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
function unprepare(seen, po, position) {
  if (po.hasOwnProperty("ctor")) {
    return unprepare$obj(seen, po, position);
  }
  if (po.hasOwnProperty("json")) {
    return JSON.parse(po.json);
  }
  if (po.hasOwnProperty("undefined")) {
    return undefined;
  }
  if (po.hasOwnProperty("seen")) {
    if (!seen.hasOwnProperty(po.seen))
      throw new Error("Seen-list corruption detected at index " + po.seen);
    return seen[po.seen];
  }
  throw new TypeError("Invalid serialization format at " + position);
}

function unprepare$obj(seen, po, position)
{
  let o;

  if (!po.ctor.match(/^[A-Za-z_0-9$][A-Za-z_0-9$]*$/))
    throw new Error("Invalid constructor name: " + po.ctr);
  if (exports.constructorWhitelist && exports.constructorWhitelist.indexOf(po.ctr) === -1)
    throw new Error("Whitelist does not include constructor " + po.ctr);
  if (po.hasOwnProperty('ctorArg'))
    o = new (eval(po.ctor))(po.ctorArg);
  else
    o = new (eval(po.ctor))();

  seen.push(o);

  if (po.hasOwnProperty('props')) {
    for (let prop in po.props) {
      if (po.props.hasOwnProperty(prop))
	o[prop] = unprepare(seen, po.props[prop], position + "." + prop);
    }
  }

  return o;
}

/** Take an arbitrary object and turn it into a 'prepared object'.  
 *  A prepared object can always be represented with JSON.
 *
 *  @param      seen    An array objects we have already seen in this
 *                      object graph; used to track cycles.
 *  @param      o       The object that the prepared object reflects
 *  @returns            A prepared object
 */
function prepare(seen, o) {
  let i, po = {};

  if ((i = seen.indexOf(o)) === -1) {
    seen.push(o)
  } else {
    return { seen: i }
  }
  
  for (let prop in o) {
    if (!o.hasOwnProperty(prop))
      continue;

    switch (typeof o[prop]) {
      default:
      case 'function':
        throw new TypeError('Cannot serialize property ' + prop + ' which is a ' + typeof o[prop]);
      case 'object':
        if (o[prop] !== null && typeof o[prop].toJSON === "undefined") {
  	  if (o[prop].constructor !== Object && o[prop].constructor.constructor !== Object)
	    throw new Error('Cannot serialize property ' + prop + ' - multiple inheritance is not supported');
	  if (ArrayBuffer.isView(o[prop])) {
	    po[prop] = prepare$ArrayBuffer(o[prop])
	  } else {
	    if ((i = seen.indexOf(o[prop])) === -1) {
              po[prop] = { ctor: o[prop].constructor.name, props: prepare(seen, o[prop]) };
	    } else {
	      po[prop] = { seen: i }
	    }
	  }
	  break;
        } /* else fallthrough */
      case 'number':
      case 'boolean':
      case 'string':
        po[prop] = prepare$primitive(o[prop]);
      break;
      case 'undefined':
        po[prop] = prepare$undefined(o[prop]);
      break;
    }
  }

  return po;
}

function prepare$ArrayBuffer(o) {
  // alt impl: return { ctor: o.constructor.name, ctorArg: o.length, props: o }
  return { ctor: o.constructor.name, ctorArg: Array.prototype.slice.call(o) }
}

function prepare$primitive(o) {
  return { json: JSON.stringify(o) }
}

function prepare$undefined(o) {
  return { undefined: true }
}

/** Serialize a value.
 *  @param      what    The value to serialize
 *  @returns    The JSON serialization of the prepared object representing what.
 */
function serialize(what) {
  var prepared;

  switch (typeof what) {
    case 'function':
      throw new TypeError('Cannot serialize ' + typeof what);
    case "string":
    case 'number':
    case 'boolean':
      prepared = prepare$primitive(what);
      break;
    case 'undefined':
      prepared = prepare$undefined(what);
      break;
    case 'object':
      if (Array.isArray(what) || typeof what.toJSON !== "undefined") {
	prepared = prepare$primitive(what);
	break;
      } else {
	if (ArrayBuffer.isView(what)) {
	  prepared = prepare$ArrayBuffer(what);
	  break;
	}
      } /* else fallthrough */
    default:
      prepared = { ctor: "Object", props: prepare([], what) };
  }

  return JSON.stringify(prepared);
}

/** Deserialize a value.
 *  @param      str     The JSON serialization of the prepared object representing the value.
 *  @returns    The deserialized value
 */
function deserialize(str) {
  return unprepare([], JSON.parse(str), "top");
}

exports.serialize = serialize;
exports.deserialize = deserialize;
