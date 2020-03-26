function timestamp() {
    return new Date().toISOString();
}

let name = '';
function setThreadName (newName) {
    name = newName;
}
exports.setThreadName = setThreadName;

function mkPrefix (type) {
    if (name) return `[${name}:${type}]`;
    return `[${type}]`;
}

function debug (msg) {
    process.stderr.write(`\x1b[90m${mkPrefix('DBG')} ${msg}\x1b[m\n`);
}
exports.debug = debug;

function info (msg) {
    const time = timestamp();
    process.stderr.write(`\x1b[34m${mkPrefix('INFO')} [${time}] ${msg}\x1b[m\n`);
}
exports.info = info;

function error (msg) {
    const time = timestamp();
    process.stderr.write(`\x1b[31m${mkPrefix('ERR')} [${time}] ${msg}\x1b[m\n`);
}
exports.error = error;
