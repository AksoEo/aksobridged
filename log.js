export function timestamp() {
    return new Date().toISOString();
}

export function info (msg) {
    const time = timestamp();
    process.stdout.write(`\x1b[34m[INFO] [${time}] ${msg}\x1b[m\n`);
}
