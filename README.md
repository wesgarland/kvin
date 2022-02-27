# `KVIN` - A rich serialization library for JavaScript.

## TLDR;
```javascript
const KVIN = require('kvin');
let s = KVIN.stringify(complexType);
let x = KVIN.parse(s);
```

## Overview
*KVIN* - pronounced "Kevin" - serializes (and deserializes) JavaScript types for transmission over a
network or storage to disk in a way that co-exists peacefully with JSON, but it supports many more
data types, including:

* undefined, null, NaN, Infinity, -Infinity, -0
* Typed Arrays (Float64Array, Int64Array, etc)
* Object graphs with cycles
* Arrays with enumerable, non-numeric properties
* Sparse Arrays
* Date
* URL
* Error
* BigInt
* Regular Expressions
* Instances of user-defined classes
* Boxed primitives (excluding Symbol)
* Functions (including enumerable properties)
* Promises which always resolve to any of the above

This library is safe to use on user-supplied data and has no dependencies.

## Supported Platforms
 - Browser (no framework needed)
 - Node.js
 - BravoJS
 - Probably every >= ES5 environment

## Examples

### Simple
```javascript
const KVIN = require('kvin');
const obj = {};

obj.foo = "hello, world";

var obj_string = KVIN.serialize(obj);
var obj2 = KVIN.deserialize(obj_string);

console.log(obj2.foo);
```

### Object With Cycle
```javascript
const KVIN = require('kvin');
const obj = {};

obj.foo = "hello, world";
obj.bar = obj; /* make a circular reference */

var obj_string = KVIN.serialize(obj);
var obj2 = KVIN.deserialize(obj_string);

console.log(obj2.bar.bar.bar.bar.foo);
```

### Float64Array (Typed Array)
```javascript
const KVIN = require('kvin');
const obj = new Float64Array([1.0, 2.0, Math.PI, NaN, Infinity, -Infinity]);

var obj_string = KVIN.serialize(obj);
var obj2 = KVIN.deserialize(obj_string);

console.log(obj2);
```

## Details
The basic implementation strategy is to marshal to an intermediate format, called a 'prepared object', that can be used to recreate
the original object, but can also be serialized with JSON. We track a list objects we have seen and their initial appearance in
the object graph.  We rely on the /de-facto/ enumeration order of properties in vanilla objects that has been present in all popular
browsers since the dawn of time; namely, that enumeration order is object insertion order. This could cause bugs with objects with
cycles in less-common interpreters, such as Rhino and the NJS/NGS ES3 platform by Brian Basset.

There may be different ways to encode the same data when marshaling; these techniques can sometimes be chosen by heuristic
or performance tuning properties, but every possible encoding can be decoded by the unmarshal code.

Typed Arrays are encoded by encoding the direct underlying bits into 8-bit characters which then wind up as UTF-8 strings. There 
is vestigial support for a more efficient UTF-16 encoding, however we have found practical problems related to networking stacks
rewriting unpaired surrogates as "invalid" codepoints.  This may be revisited in the future, as it should shrink eventual payload
size.

### Compression
We recommend transmitting all data over the network compressed at the network layer (e.g. content-transfer-encoding: gzip). The
serializer, in certain modes, will do a sort of "run length limited" encoding on Typed Array data; specifically, the islz
"Islands of Zero" encoding is optimized for mostly-empty blocks of memory (our initial use for this library was for images
in an astrophysics application).  

### Interoperation with JSON
KVIN and JSON go together like peas and carrots. If you are creating a payload object which will be stringified by JSON in the
future, do NOT use `kvin.serialize()`; instead, use `kvin.marshal()`. This will get you all the benefits of Kvin without the
cost of double-stringification. Similarly, at the receiving end, use `kvin.unmarshal()` to reconstruct your data.

#### Substitution for JSON
```javascript
const JSON = require('./kvin');
```

### Loading
#### Browser
global KVIN object:
```html
<script src="/path/to/kvin.js"></script>
<script>
  KVIN.stringify({my: "object"});
</script>
```

#### Node.js
```javascript
const kvin = require('kvin');
kvin.serialize(foo: "bar"});
```

#### No Module System
```javascript
const code = "the contents of kvin.js";
const kvin = eval(code);
kvin.serialize({foo: "bar"});
```

### Module Exports
#### API Functions
| Function       | Argument	| Behaviour
|----------------|--------------|-------------------------------------------------------------
| serialize 	 | any		| returns a string representing the argument
| serializeAsync | any		| returns a Promise which resolves to a string representing the argument. Any Promises encountered while traversing the object graph (argument) will be awaited, and their resolved values will be serialized. Deserialization will generate Promises which resolve to these values.
| deserialize    | string	| returns a facsimile of the argument passed to serialize
| stringify      | any		| alias for serialize
| parse          | any		| alias for deserialize
| marshal	 | any		| like serialize, but returns a JSON-compatible object 
| marshalAsync   | any		| like serializeAsync, but returns a JSON-compatible object
| unmarshal	 | object	| like deserialize, but operates on marshaled objects instead of strings
| kvin           | object       | constructor to create a custom KVIN instance, with its own tuning parameters and Standard Classes.

### KVIN Instance Properties
| Property   	          | Default | Description
|-------------------------|---------|---------------------------------------------------------
| allowConstructorList    |         | Array which is a list of non-standard constructors that KVIN will try to deserialize
| userCtors               | {}      | Dictionary; keys are constructor names, values are constructor functions for user-defined classes
| makeFunctions           | false   | When true allows Kvin to deserialize Functions

#### Tuning Values
| Property   	          | Default | Description
|-------------------------|---------|---------------------------------------------------------
| tune                    |         | Set to "speed" for fast operation, or "size" for small operation. Default value, undefined, balances both.
| typedArrayPackThreshold | 8	    | When to start trying to use islands-of-zeros encoding; bigger numbers mean faster encoding/decoding but longer strings.
| scanArrayThreshold      | 8       | When to start trying to use sparse-array representation for Arrays; bigger numbers mean faster encoding/decoding but longer strings.

