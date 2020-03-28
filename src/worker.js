const { Server } = require('net');
const { workerData, parentPort } = require('worker_threads');
const { UserClient } = require('@tejo/akso-client');
const { CookieJar } = require('tough-cookie');
const { encode, decode } = require('@msgpack/msgpack');
const { setThreadName, info, debug, error } = require('./log');

process.on('uncaughtException', err => {
    error(`!!!! uncaught exception`);
    console.error(err);
});

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
        if (message.type === 'close') {
            debug('closing server');
            server.close();
            info('server closed');
            setTimeout(() => {
                channel.close();
            }, 30);
        }
    });

    const server = new Server(conn => {
        new ClientHandler(conn);
    });

    const listenAddr = `${workerData.path}/ipc${workerData.id}`;
    server.listen(listenAddr, () => {
        info(`listening on ${listenAddr}`);
    });
}

const MAGIC = Buffer.from('abx1');
const MAX_SANE_MESSAGE_LEN = 10 * 1024 * 1024; // 10 MiB

const encodeMessage = msg => {
    const packed = Buffer.from(encode(msg));
    const buf = Buffer.allocUnsafe(packed.length + 4);
    buf.writeInt32LE(packed.length, 0);
    packed.copy(buf, 4);
    return buf;
};

class ClientHandler {
    constructor (connection) {
        this.connection = connection;
        this.connection.setTimeout(1000);
        this.connection.on('data', data => this.onData(data));
        this.connection.on('timeout', () => this.onTimeout());
        this.connection.on('close', () => this.onClose());

        this.didInit = false;
        this.currentMessageLen = null;
        this.currentMessageBuffer = null;
        this.currentMessageCursor = 0;
        this.didEnd = false;

        // -----
        this.didHandshake = false;
        this.ip = null;
        this.cookies = null;
        this.client = null;
        this.waitTasks = 0;
    }

    flushMessage () {
        this.currentMessageLen = null;
        let decoded;
        try {
            decoded = decode(this.currentMessageBuffer);
            if (typeof decoded !== 'object') throw new Error('expected object as root');
            if (typeof decoded.t !== 'string') throw new Error('expected t: string');
            if (typeof decoded.i !== 'string') throw new Error('expected i: string');
        } catch (err) {
            this.close('TXERR', 402, `failed to decode input: ${err}`);
            return;
        }

        this.handleInput(decoded);
    }

    onData (data) {
        let cursor = 0;

        if (!this.didInit) {
            if (data.slice(0, MAGIC.length).equals(MAGIC)) {
                this.didInit = true;
                cursor += MAGIC.length;
            } else {
                this.close('TXERR', 400, 'bad magic');
                return;
            }
        }

        while (cursor < data.length) {
            if (this.currentMessageLen === null) {
                // awaiting message length
                this.currentMessageLen = data.readInt32LE(cursor);
                if (this.currentMessageLen < 0) {
                    this.close('TXERR', 401, 'message has negative length');
                    return;
                } else if (this.currentMessageLen > MAX_SANE_MESSAGE_LEN) {
                    this.close('TXERR', 401, 'message is too long');
                    return;
                }
                cursor += 4;
                this.currentMessageBuffer = Buffer.allocUnsafe(this.currentMessageLen);
                this.currentMessageCursor = 0;
            } else {
                // message contents
                const messageBytesLeft = this.currentMessageLen - this.currentMessageCursor;
                const inputBytesLeft = data.length - cursor;

                if (inputBytesLeft >= messageBytesLeft) {
                    // rest of message is entirely contained in data
                    data.copy(this.currentMessageBuffer, this.currentMessageCursor, cursor, cursor + messageBytesLeft);
                    this.flushMessage();
                    cursor += messageBytesLeft;
                } else {
                    // data contains a part of the message
                    data.copy(this.currentMessageBuffer, this.currentMessageCursor, cursor, cursor + inputBytesLeft);
                    this.currentMessageCursor += inputBytesLeft;
                    cursor += inputBytesLeft;
                }
            }
        }
    }

    send (data) {
        if (this.didEnd) return;
        this.connection.write(encodeMessage(data));
    }

    close (t, c, m) {
        if (this.didEnd) return;
        this.didEnd = true;
        this.connection.end(encodeMessage({ t, c, m }));
    }

    onClose () {
        this.flushSendCookies();
        this.didEnd = true;
    }

    onTimeout () {
        if (this.waitTasks > 0) {
            this.send({ t: '❤' });
        } else {
            this.close('TXERR', 103, 'timed out');
        }
    }

    // -----

    handleInput (message) {
        if (!this.didHandshake && message.t !== 'hi') return;

        const handler = messageHandlers[message.t];
        if (!handler) {
            this.close('TXERR', 200, `unknown message type ${message.t}`);
            return;
        }

        this.waitTasks++;
        handler(this, message).then(response => {
            this.send({
                t: '~',
                i: message.i,
                ...response,
            });
        }).catch(err => {
            this.send({
                t: '~!',
                i: message.i,
                m: err.toString(),
            });
        }).then(() => {
            this.waitTasks--;
        });
    }

    debouncedSetCookie = null;
    cookieQueue = [];
    flushSendCookies () {
        clearTimeout(this.debouncedSetCookie);
        if (this.cookieQueue.length) {
            this.send({ t: 'co', co: this.cookieQueue });
            this.cookieQueue = [];
        }
    }

    recordSetCookie (cookie) {
        this.cookieQueue.push(cookie);
        if (!this.debouncedSetCookie) {
            this.debouncedSetCookie = setTimeout(() => this.flushSendCookies(), 1);
        }
    }
}

function assertType (v, t, n) {
    let chk = typeof v === t;
    if (t === 'array') chk = Array.isArray(v);
    if (!chk) {
        throw new Error(n);
    }
}

const messageHandlers = {
    hi: async (conn, { ip, co }) => {
        debug(`connection handshake from ip ${ip}`);
        assertType(ip, 'string', 'expected ip to be a string');
        assertType(co, 'object', 'expected co to be an object');
        if (conn.didHandshake) {
            throw new Error('double handshake');
        }

        conn.cookies = {
            conn,
            jar: new CookieJar(),
            // fetch-cookie only uses these two methods
            getCookieString (...args) {
                return this.jar.getCookieString(...args);
            },
            setCookie (cookie, url, callback) {
                const { conn, jar } = this;
                conn.recordSetCookie(cookie); // FIXME: should url be checked?
                return jar.setCookie(cookie, url, callback);
            },
        };

        // initialize cookies
        for (const k in co) {
            const v = co[k];
            assertType(v, 'string', 'expected cookie value to be a string');
            conn.cookies.jar.setCookieSync(`${k}=${v}`, workerData.host);
        }

        // TODO: pass IP somehow...?
        conn.client = new UserClient({
            host: workerData.host,
            userAgent: workerData.userAgent,
            cookieJar: conn.cookies,
            headers: {
                'X-Forwarded-For': ip,
            },
        });

        conn.didHandshake = true;

        const sesx = await conn.client.restoreSession();
        if (sesx === false) return { auth: false };
        return {
            auth: true,
            uea: sesx.newCode,
            id: sesx.id,
            totp: sesx.totpSetUp && !sesx.totpUsed,
        };
    },
    login: async (conn, { un, pw }) => {
        assertType(un, 'string', 'expected un to be a string');
        assertType(pw, 'string', 'expected pw to be a string');
        try {
            const sesx = await conn.client.logIn(un, pw);
            return {
                s: true,
                uea: sesx.newCode,
                id: sesx.id,
                totp: sesx.totpSetUp && !sesx.totpUsed,
            };
        } catch (err) {
            if (err.statusCode === 401) {
                return { s: false, nopw: false };
            } else if (err.statusCode === 409) {
                return { s: false, nopw: true };
            } else {
                throw err;
            }
        }
    },
    logout: async (conn) => {
        try {
            await conn.client.logOut();
            return { s: true };
        } catch (err) {
            if (err.statusCode === 404) {
                return { s: false };
            } else {
                throw err;
            }
        }
    },
    totp: async (conn, { co, se, r }) => {
        assertType(co, 'string', 'expected co to be a string');
        assertType(r, 'boolean', 'expected r to be a bool');
        try {
            if (se) {
                await conn.client.totpSetUp(se, co, r);
            } else {
                await conn.client.totpLogIn(co, r);
            }
            return { s: true };
        } catch (err) {
            if (err.statusCode === 401) {
                return { s: false, bad: false, nosx: false };
            } else if (err.statusCode === 403) {
                return { s: false, bad: true, nosx: false };
            } else if (err.statusCode === 404) {
                return { s: false, bad: false, nosx: true };
            } else {
                throw err;
            }
        }
    },
    '-totp': async (conn) => {
        try {
            await conn.client.totpRemove();
            return { s: true };
        } catch (err) {
            if (err.statusCode === 401 || err.statusCode === 404) {
                return { s: false };
            } else {
                throw err;
            }
        }
    },
    get: async (conn, { p, q }) => {
        assertType(p, 'string', 'expected p to be a string');
        assertType(q, 'object', 'expected q to be an object');

        try {
            const res = await conn.client.get(p, q);
            return {
                k: res.ok,
                sc: res.res.statusCode,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    delete: async (conn, { p, q }) => {
        assertType(p, 'string', 'expected p to be a string');
        assertType(q, 'object', 'expected q to be an object');

        try {
            const res = await conn.client.delete(p, q);
            return {
                k: res.ok,
                sc: res.res.statusCode,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    post: async (conn, { p, b, q, f }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');
        assertType(f, 'object', 'expected f to be an object');

        const files = [];
        for (const n in f) {
            const file = f[n];
            assertType(file, 'object', 'expected file to be an object');
            assertType(file.t, 'string', 'expected file.t to be a string');
            files.push({
                name: n,
                type: file.t,
                value: file.b,
            });
        }

        try {
            const res = await conn.client.post(p, b, q, files);
            return {
                k: res.ok,
                sc: res.res.statusCode,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    put: async (conn, { p, b, q, f }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');
        assertType(f, 'object', 'expected f to be an object');

        const files = [];
        for (const n in f) {
            const file = f[n];
            assertType(file, 'object', 'expected file to be an object');
            assertType(file.t, 'string', 'expected file.t to be a string');
            files.push({
                name: n,
                type: file.t,
                value: file.b,
            });
        }

        try {
            const res = await conn.client.put(p, b, q, files);
            return {
                k: res.ok,
                sc: res.res.statusCode,
                h: collectHeaders(res.res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    patch: async (conn, { p, b, q }) => {
        assertType(p, 'string', 'expected p to be a string');
        if (b !== null) assertType(b, 'object', 'expected b to be an object or null');
        assertType(q, 'object', 'expected q to be an object');

        try {
            const res = await conn.client.patch(p, b, q);
            return {
                k: res.ok,
                sc: res.res.statusCode,
                h: collectHeaders(res.headers),
                b: res.body,
            };
        } catch (err) {
            return {
                k: false,
                sc: err.statusCode,
                h: {},
                b: err.toString(),
            };
        }
    },
    perms: async (conn, { p }) => {
        assertType(p, 'array', 'expected p to be an array');
        const res = [];
        for (const perm of p) {
            assertType(perm, 'string', 'expected permission to be a string');
            res.push(await conn.client.hasPerm(perm));
        }
        return { p: res };
    },
    permscf: async (conn, { f }) => {
        assertType(f, 'array', 'expected f to be an array');
        const res = [];
        for (const fieldFlags of f) {
            assertType(fieldFlags, 'string', 'expected field.flags to be a string');
            const parts = fieldFlags.split('.');
            const field = parts[0];
            const flags = parts[1];
            res.push(await conn.client.hasCodeholderField(field, flags));
        }
        return { f: res };
    },
    permsocf: async (conn, { f }) => {
        assertType(f, 'array', 'expected f to be an array');
        const res = [];
        for (const fieldFlags of f) {
            assertType(fieldFlags, 'string', 'expected field.flags to be a string');
            const parts = fieldFlags.split('.');
            const field = parts[0];
            const flags = parts[1];
            res.push(await conn.client.hasOwnCodeholderField(field, flags));
        }
        return { f: res };
    },
    x: async (conn) => {
        conn.flushSendCookies();
        return {};
    },
};

function collectHeaders (headers) {
    const entries = {};
    for (const [k, v] of headers.entries()) {
        entries[k.toLowerCase()] = v;
    }
    return entries;
}
