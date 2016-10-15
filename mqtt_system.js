var mqtt = require('mqtt')
var os = require('os')
var fs = require('fs')
var path = require('path')
var util = require('util')

function NotImplementedError() {
  Error.apply(this, arguments)
}
util.inherits(NotImplementedError, Error)

var host = os.hostname()
var client = mqtt.connect("mqtt://" + process.argv[2])

/**
  Publish to a topic but only while not subscribed to it.

  Usage:
    client => MQTT client instance
    system => System instance
    callback => function taking one parameter which will be a function that
                will publish an MQTT payload. Same usage as mqtt.Client#publish
  And one of the following groups(with the other options null):
  1)  handler => Handler instance
      method => Function object on Handler instance
  2)  topic => raw topic string

  @method with_no_subscriptions
  @param {Object} client {{#crossLink "mqtt.Client"}}MQTT client{{/crossLink}}
  @param {Object} system {{#crossLink "System"}}System{{/crossLink}} object
  @param {Object} handler {{#crossLink "Handler"}}Handler{{/crossLink}} object
  @param {Function} method function on handler
  @param {String} topic topic to use
  @param {Function} callback callback to call
*/
function with_no_subscriptions(client, system, handler, method, topic, callback) {
  var is_cmd = false
  if (handler) {
    is_cmd = method != null ? 'cmd_topic' in handler.topic_map[method] : false
  }
  client.unsubscribe(method != null ? handler.topic_map[method]['topic'] : topic)
  callback(function(pubtopic, data, options) {
    options = options || {}
    options['retain'] = is_cmd
    if (method && 'mqtt' in method) {
      Object.assign(options, method['mqtt'])
    }
    return client.publish(pubtopic, data, options, function(err) {
      // resubscribe after publish; err only happens when client disconnects so safe to ignore
      client.subscribe(method != null ? (handler.topic_map[method][is_cmd ? 'cmd_topic' : 'topic']) : topic)
    })
  })
}

function get_topic_for_method(topic, method) {
  return 'is_hostbased' in method ? topic.replace('HOST', host) : topic
}
/**
System coordinates message handlers and subscriptions

@class System
@constructor
@param {Object} client {{#crossLink "mqtt.Client"}}MQTT client{{/crossLink}}
@param {Array} handlers array of handlers to use
*/
function System(client, handlers) {
  var self = this
  self.host = host
  self.client = client
  self.handlers = {}
  self.addHandlers(handlers)
  self.client.on("connect", function() {
    self.on_connect()
  })
  self.client.on("message", function(topic, message) {
    self.on_message(topic, message)
  })
}
/**
Add some handlers to this System

@method addHandlers
@param {Array} handlers an array of {{#crossLink "Handler"}}Handler{{/crossLink}} objects
*/
System.prototype.addHandlers = function(handlers) {
  var self = this
  var hs = handlers || []
  hs.forEach((h) => {
    self.addHandler(h)
  })
}
/**
Add a handler to this System

@method addHandler
@param {Object} h the {{#crossLink "Handler"}}Handler{{/crossLink}} instance to add
*/
System.prototype.addHandler = function(h) {
  var self = this
  h.client = self.client
  var topics = []
  // try to get topics from the #topics function
  try {
    topics = h.topics()
  } catch (e) {

  }
  // iterate through #on(topic, callback) topics
  Object.keys(h.functions).forEach((topic) => {
    var method = h.functions[topic]
    // map methods to topics
    h.topic_map[method] = {'topic': get_topic_for_method(topic, method)}
    // command topic?
    if ('is_command' in method) {
      h.topic_map[method]['cmd_topic'] = topic + "/cmd"
      // map the command topic to the method and remove the original
      h.functions[topic + "/cmd"] = method
      delete h.functions[topic]
      topics.push(topic + "/cmd")
    // host-based topic?
  } else if ('is_hostbased' in method) {
      h.functions[get_topic_for_method(topic, method)] = method
      topics.push(get_topic_for_method(topic, method))
    // normal topic
    } else {
      topics.push(topic)
    }
  })
  // map topics to handlers
  topics.forEach((topic) => {
    self.handlers[topic] = h
  })
}

System.prototype.on_connect = function() {
  var self = this
  Object.keys(self.handlers).forEach((topic) => {
    self.client.subscribe(topic)
  })
}

System.prototype.on_message = function(topic, message) {
  /**
  The idea here is to call the appropriate method registered to a topic,
  if one exists. If no such method exists, call the generic {{#crossLink "Handler/handle:method"}}handler{{/crossLink}}
  */
  var self = this
  var handler = self.handlers[topic]
  // dev did handler#on("topic", callback)?
  if (topic in handler.functions) {
    var method = handler.functions[topic]
    var response = method(message)
    // publish responses by returning a value
    if (response != null) {
      var opts = {'retain': 'is_command' in method}
      // (client, system, handler, method, topic, callback)
      with_no_subscriptions(self.client, self, handler, method, topic, (publish) => {
        publish(handler.topic_map[method]['topic'], response, opts)
      })
    }
  } else {
    // no callback given for a specific topic, pass through to generic handler
    with_no_subscriptions(self.client, self, handler, null, topic, (publish) => {
      handler.handle(publish, topic, message)
    })
  }
}
/**
= Implementing a Handler =
Handling classes inherit from Handler and have options for how to implement,
in order of size of code to be implemented (low to high):
    1) call #on("/topic/name/here", callback)
        will subscribe to /topic/name/here and messages will be dispatched
        to the passed callback
    2) implement #topics() and implement #handle(publisher, topic, payload)
        each topic subscribed to will invoke handle(topic, payload) when a
        message is received. Publishing a response should be done with
        publisher as it's not automatic.
Implementing (1) means not having to worry if you've forgotten to handle a topic.

== Sending A Response ==
Returning data from callbacks will send that same data back out on the same
topic. The system automatically unsubscribes before sending and resubscribes
after so no infinite loops occur. Messages are not marked as "retain".

== Command/State ==
If you wrap your callback with system.command, the topic subscribed will have
'/cmd' appended and returning data from the function will publish to the non-cmd
topic with the "retain" flag set.

== Hostnames In Topics ==
If you use the topic /some/topic/HOST/here and wrap it with system.hostbased,
the topic will have HOST replaced by the local hostname.
Method routing works as expected: the passed callback will be called, instead of
passing through to #handle(topic, payload)

== Response Options ==
Things like QoS can be set on response messages by wrapping with "system.param()".
"key" and "value" are added to options verbatim on client.publish. "retain" can
only be set by "system.command" to avoid infinite loops. While multiple
options can be set, MQTT currently only supports QoS and retain.

== Instance Attributes ==

Each Handler class has `host` and `client` attributes, containing the local hostname
and the MQTT client instance respectively.

= Registering A Handler =
system.js loads modules in jsmodules and for each module, invokes the single exported
function, passing the current hostname and an implementation of client. Implementations
must either return system.make_handler(YourHandler) or false-y if some
implementer-defined condition is not met (eg: module only applicable on a
specific platform, host, with a specific device attached, etc).

= Sample Handler =
var system = require('../mqtt_system.js')

function MyHandler(host, client) {
  Handler.call(this, host, client)
  this.on("/my/topic", (data) => {return data})
  this.on("/my/command", system.command((data) => {return data}))
  this.on("/my/HOST/path", system.hostbased((data) => {console.log(data)}))
}
MyHandler.prototype.topics = function() {
  return ['/topic/can"t/make/method']
}
MyHandler.prototype.handle = function(publisher, topic, payload) {
  publisher("/another/topic", payload)
}

module.exports = function(host, client) {
  if (my_condition_here()) {
    return system.make_handler(MyHandler)
  }
}

== Results with Sample Handler ==
publish to /my/topic:
    MyHandler.on_my_topic called, data sent back to /my/topic.
publish to /my/command/cmd:
    MyHandler.on_my_command called, data sent back to /my/command.
publish to /topic/can"t/make/method:
    MyHandler.handle called, data sent back to /topic/can"t/make/method
publish to /my/somehostname.local/path:
    MyHandler.on_my_HOST_path called, data sent back to /my/somehostname.local/path

*/
function Handler(host) {
  this.host = host
  this.client = null
  this.functions = {}
  this.topic_map = {}
}

Handler.prototype.topics = function() {
  throw new NotImplementedError('must implement')
}

Handler.prototype.on = function(topic, callback) {
  this.functions[topic] = callback
}

Handler.prototype.handle = function() {
  throw new NotImplementedError('must implement')
}

function hostbased(f) {
  return handler({'is_hostbased': true}, f)
}

function command(f) {
  return handler({'is_command': true}, f)
}

function param(f, key, val) {
  if (!f.hasOwnProperty("mqtt")) {
    f['mqtt'] = {}
  }
  f['mqtt'][key] = val
  return f
}

function handler(opts, callback) {
  return Object.assign(callback, opts)
}

function make_handler(SomeHandler) {
  util.inherits(SomeHandler, Handler)
  return new SomeHandler(host, client)
}

module.exports = {
  'Handler': Handler,
  'make_handler': make_handler,
  'command': command,
  'hostbased': hostbased,
  'param': param
}

var system = new System(client)

fs.readdir('jsmodules', function(err, files) {
  if (err) return console.error(err);
  files.map((x) => path.join('jsmodules', x)).
    filter((x) => fs.statSync(x).isFile()).
    filter((x) => path.extname(x) == ".js").
    forEach((x) => {
      var mod = require('./' + x)
      var h = mod(host, client)
      if (h) {
        system.addHandler(h)
      }
    })
})
