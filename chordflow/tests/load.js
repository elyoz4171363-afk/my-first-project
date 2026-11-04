// Loads the browser modules into Node (they register on globalThis.CF).
const path = require('path');
['theory', 'registry', 'voicing', 'patterns', 'dynamics', 'arranger', 'midi', 'project'].forEach((m) =>
  require(path.join(__dirname, '..', 'js', m + '.js')));
module.exports = globalThis.CF;
