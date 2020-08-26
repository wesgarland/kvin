# `Kvin` - A rich serialization library for JavaScript.

## Overview
*Kvin* - pronounced "Kevin" - serializes (and deserializes) JavaScript types for transmission over a
network or storage to disk in a way that co-exists peacefully with JSON, but it supports many more
data types, including:

* undefined, null, NaN, Infinity, -Infinity
* Typed Arrays (Float64Array, Int64Array, etc)
* Object graphs with cycles
* Arrays with enumerable, non-numeric properties
* Sparse Arrays
* Date
* URL
* Regular Expressions
* Instances of user-defined classes
* Boxed primitives (excluding Symbol)
* Functions (including enumerable properties)

This library is safe to use on user-supplied data.

## Examples

### Simple
```javascript
const kvin = require('./kvin');
const obj = {};

obj.foo = "hello, world";

var obj_string = kvin.serialize(obj);
var obj2 = kvin.deserialize(obj_string);

console.log(obj2.foo);
```

### Object With Cycle
```javascript
const kvin = require('./kvin');
const obj = {};

obj.foo = "hello, world";
obj.bar = obj; /* make a circular reference */

var obj_string = kvin.serialize(obj);
var obj2 = kvin.deserialize(obj_string);

console.log(obj2.bar.bar.bar.bar.foo);
```

### Float64Array (Typed Array)
``javascript
const kvin = require('./kvin');
const obj = new Float64Array([1.0, 2.0, Math.PI, NaN, Infinity, -Infinity]);

var obj_string = kvin.serialize(obj);
var obj2 = kvin.deserialize(obj_string);

console.log(obj2);
```

## Details
The basic implementation strategy is to marshal to an intermediate format, called a 'prepared object', that can be used to recreate
the original object, but can also be serialized with JSON. We track a list objects we have seen and their initial appearance in
the object graph.  We rely on the /de-facto/ enumeration order of properties in vanilla objects that has been present in all popular
browsers since the dawn of time; namely, that enumeration order is object insertion order. This could cause bugs with objects with
cycles in less-common interpreters, such as Rhino and the NJS/NGS ES3 platform by Brian Basset.

There many be different ways to encode the same data when marshaling; these techniques can sometimes be chosen by heuristic
or performance tuning properties, but every possible encoding can be decoded by the unmarshal code.

Typed Arrays are encoded by encoding the direct underlying bits into 8-bit characters which then wind up as UTF-8 strings. There 
is vestigial support for a more efficient UTF-16 encoding, however we have found practical problems related to networking stacks
rewriting unpaired surrogates as "invalid" codepoints.  This may be revisited in the future, as it should shrink eventual payload
size.

### Compression
We recommend transmitting all data over the network compressed at the network layer (e.g. content-transfer-encoding: gzip). The
serializer, in certain modes, will do a sort of "run length limited" encoding on Typed Array data; specifically, the islz
"Islands of Zero" encoding is optimized for mostly-empty blocks of memory (our initial use for this library was images
for in astrophysics application).  

### Interoperation with JSON
Kvin and JSON go together like peas and carrots. If you are creating a payload object which will be stringified by JSON in the
future, do NOT use `kvin.serialize()`; instead, use `kvin.marshal()`. This will get you all the benefits of Kvin without the
cost of double-stringification. Similarly, at the receiving end, use `kvin.unmarshal()` to reconstruct your data.
