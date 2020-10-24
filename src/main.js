const { Worker, isMainThread, MessageChannel } = require('worker_threads');
const { cpus: getCPUs } = require('os');
const { promisify } = require('util');
const path = require('path');
const fs = require('fs');
const { decode } = require('@msgpack/msgpack');
const { setThreadName, debug, info, error } = require('./log.js');
const { version } = require('../package.json');

if (!isMainThread) {
    error('main.js running off-thread');
    process.exit(1);
}

setThreadName('MAIN');

// set up disk cache directory
const cachePath = 'run/cache';
fs.mkdirSync(cachePath, { recursive: true, mode: 0o755 });

// set up socket directory
const bridgePath = 'aksobridge';
fs.mkdirSync(bridgePath, { recursive: true, mode: 0o755 });
const userAgent = `AKSOBridge/${version} (+https://github.com/AksoEo/aksobridged)`;

let isClosing = false;

function createWorkerInSlot (id) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { path: bridgePath, id, userAgent, cachePath },
    });
    const { port1: mainPort, port2: workerPort } = new MessageChannel();
    worker.postMessage({ type: 'init', channel: workerPort }, [workerPort]);
    worker.on('error', err => {
        mainPort.close();
        error(`worker ${id} terminated: ${err}`);
    });
    worker.on('exit', code => {
        if (!isClosing) {
            info(`worker exited with code ${code}; creating new worker in slot ${id}`);
            createWorkerInSlot(id);
        }
    });
    pool[id] = { worker, channel: mainPort };
}

const cpus = getCPUs().length;
debug(`found ${cpus} cpu threads`);
const pool = [];
for (let i = 0; i < cpus; i++) {
    createWorkerInSlot(i);
}

let gcInterval;

function close () {
    if (isClosing) return;
    clearInterval(gcInterval);
    isClosing = true;
    info('closing all workers');
    const terminatePromises = [];
    for (const item of pool) {
        item.channel.postMessage({ type: 'close' });
        terminatePromises.push(new Promise(resolve => {
            item.channel.on('close', () => {
                item.worker.terminate();
                resolve();
            });
        }));
    }
    Promise.all(terminatePromises).then(() => {
        fs.rmdirSync(bridgePath);
    }).catch(error);
}

process.on('SIGINT', close);

// cache garbage collector
// see worker.js for details on file structure
const fsReaddir = promisify(fs.readdir);
const fsStat = promisify(fs.stat);
const fsReadFile = promisify(fs.readFile);
const fsUnlink = promisify(fs.unlink);

async function cacheGC () {
    const files = await fsReaddir(cachePath);

    for (const file of files) {
        if (file.startsWith('$')) continue; // tmp file
        const filePath = path.join(cachePath, file);

        try {
            const stats = await fsStat(filePath);
            const contents = await fsReadFile(filePath);

            let shouldDelete = false;
            try {
                const rootNode = decode(contents);
                const age = (Date.now() - stats.mtimeMs) / 1000;
                shouldDelete = age > rootNode.maxAge;
            } catch {
                // decode error; file can’t be read anyway
                shouldDelete = true;
            }

            if (shouldDelete) {
                await fsUnlink(filePath);
            }
        } catch (err) {
            error(`GC error for file ${file}: ${err}`);
        }
    }

    debug('completed GC sweep');
}
gcInterval = setInterval(() => {
    cacheGC().catch(err => error(`GC error: ${err}`));
}, 120000);
