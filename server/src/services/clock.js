// All business timestamps come from here so tests can control time without
// waiting for real minutes to pass.
let source = () => new Date()

module.exports = {
  now: () => source(),
  set(fn) {
    source = fn
  },
  reset() {
    source = () => new Date()
  }
}
