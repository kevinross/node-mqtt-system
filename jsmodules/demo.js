var system = require('../mqtt_system.js')

function MyHandler(host, client) {
  system.Handler.call(this, host, client)
  this.on("/my/topic", (data) => {return data})
  this.on("/my/command", system.command((data) => {return data}))
  this.on("/my/HOST/path", system.hostbased((data) => {console.log(data)}))
}
MyHandler.prototype.topics = function() {
  return ['/topic/can"t/make/method2']
}
MyHandler.prototype.handle = function(publisher, topic, payload) {
  console.log('in handle')
  publisher("/another/topic", payload)
}

function my_condition_here() {
  return false
}
module.exports = function(host, client) {
  if (my_condition_here()) {
    return system.make_handler(MyHandler)
  }
}
