const { Worker, isMainThread, MessageChannel } = require('worker_threads');
const { cpus: getCPUs } = require('os');
const path = require('path');
const fs = require('fs');
const { setThreadName, debug, info, error } = require('./log.js');
const { version } = require('../package.json');

if (!isMainThread) {
    error('main.js running off-thread');
    process.exit(1);
}

setThreadName('MAIN');

const bridgePath = 'aksobridge';
fs.mkdirSync(bridgePath, { recursive: true, mode: 0o755 });
const host = 'https://apitest.akso.org'; // TODO: make configurable
const userAgent = `AKSOBridge/${version} (+https://github.com/AksoEo/aksobridged)`;

let isClosing = false;

function createWorkerInSlot (id) {
    const worker = new Worker(path.join(__dirname, 'worker.js'), {
        workerData: { path: bridgePath, id, host, userAgent },
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

function close () {
    if (isClosing) return;
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
