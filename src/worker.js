const { Server } = require('net');
const { workerData, parentPort } = require('worker_threads');
const { setThreadName, info, debug } = require('./log');

setThreadName(`W${workerData.id}`);
parentPort.on('message', message => {
    if (!message) return;
    if (message.type === 'init') {
        init(message.channel);
    }
});

function init (channel) {
    debug('initializing');

    channel.on('message', message => {
        if (message.type === 'connection') {
            debug('got connection message');

            handle(message.connection);
        } else if (message.type === 'close') {
            debug('closing server');
            server.close();
            info('server closed');
            setTimeout(() => {
                channel.close();
            }, 30);
        }
    });

    const server = new Server(handle);

    const listenAddr = `./ipc${workerData.id}`;
    server.listen(listenAddr, () => {
        info(`listening on ${listenAddr}`);
    });
}

function handle (connection) {
    // TODO
    connection.on('data', data => {
        // TODO
    });
    connection.on('close', () => {
        debug('connection closed');
    });
}
