<?php
use MessagePack\Packer;
use MessagePack\MessagePack;

function encode32LE(int $n) {
    $encoded = "";
    $encoded .= chr($n & 0xFF);
    $encoded .= chr(($n >> 8) & 0xFF);
    $encoded .= chr(($n >> 16) & 0xFF);
    $encoded .= chr(($n >> 24) & 0xFF);
    return $encoded;
}

function decode32LE(string $s) {
    // for some inexplicable reason this output array is 1-indexed
    $unpacked = unpack('C*', $s);
    return $unpacked[1] | ($unpacked[2] << 8) | ($unpacked[3] << 16) | ($unpacked[4] << 24);
}

class AksoBridge {
    // socket folder path
    public $path;
    // socket file pointer
    public $conn;

    public $idCounter = 0;

    // should be used to set Set-Cookie headers after the connection has ended
    public $setCookies = [];

    private $packer;

    // creates a new AksoBridge connection at the given path.
    //
    // $path should point to the aksobridge folder which contains ipc sockets.
    public function __construct(string $path) {
        $this->path = $path;
        $this->packer = new Packer();
    }

    public function send($data) {
        $packed = $this->packer->packMap($data);
        $len = strlen($packed);
        fwrite($this->conn, encode32LE($len));
        fwrite($this->conn, $packed);
    }

    public function nextId () {
        $id = $this->idCounter;
        $this->idCounter++;
        return encode32LE($id);
    }

    public function recv() {
        $msglen = decode32LE(fread($this->conn, 4));
        $msgdata = fread($this->conn, $msglen);
        $msg = MessagePack::unpack($msgdata);
        return $msg;
    }

    public function recvUntilId(string $id) {
        while (true) {
            $msg = $this->recv();

            if ($msg['t'] === 'TXERR') {
                // transmission error, oh no
                throw new Exception('AKSO bridge tx error: ' . $msg['m'] . ' (' . $msg['c'] . ')');
            } else if ($msg['t'] === 'co') {
                // set cookies!
                $this->handleSetCookies($msg);
            } else if ($msg['t'] === '❤') {
                // heartbeat can be ignored
            } else if ($msg['t'] === '~' || $msg['t'] === '~!') {
                if ($msg['i'] === $id) {
                    if ($msg['t'] === '~!') {
                        throw new Exception('Unexpected server error: ' . $msg['m']);
                    }
                    // this is the response we’re looking for
                    return $msg;
                } else {
                    // some stray message...?
                    throw new Exception('Unexpected response message for ' . $msg['i']);
                }
            } else {
                throw new Exception('Unexpected message of type ' . $msg['t']);
            }
        }
    }

    public function handleSetCookies($msg) {
        foreach ($msg['co'] as $cookie) {
            $splitPos = strpos($cookie, "=");
            $cookieName = substr($cookie, 0, $splitPos);
            $this->setCookies[$cookieName] = $cookie;
        }
    }

    public function request(string $ty, $data) {
        $id = $this->nextId();
        $req = array_merge($data, array(
            't' => $ty,
            'i' => $id
        ));
        $this->send($req);
        return $this->recvUntilId($id);
    }

    private function openSocket() {
        $ipc_ports = [];
        // find ipc sockets in the path
        foreach (scandir($this->path) as $filename) {
            if (strpos($filename, "ipc") === 0) {
                $ipc_ports[] = $filename;
            }
        }
        // TODO: better scheduling mechanism
        $ipc_index = rand(0, count($ipc_ports) - 1);
        $ipc_name = $ipc_ports[$ipc_index];
        $this->conn = fsockopen("unix://" . $this->path . "/" . $ipc_name);
        if ($this->conn === FALSE) {
            throw new Exception('Failed to open socket');
        }
        fwrite($this->conn, "abx1");
    }

    // opens a connection
    public function open(string $apiHost, string $ip, $cookies) {
        $this->openSocket();
        return $this->handshake($apiHost, $ip, $cookies);
    }

    // opens an app connection
    public function openApp(string $apiHost, string $key, string $secret) {
        $this->openSocket();
        return $this->handshakeApp($apiHost, $key, $secret);
    }

    public function close() {
        $this->request('x', array());
        fclose($this->conn);
    }

    // ---

    public function handshake(string $apiHost, string $ip, $cookies) {
        return $this->request('hi', array(
            'api' => $apiHost,
            'ip' => $ip,
            'co' => $cookies
        ));
    }

    public function handshakeApp(string $apiHost, string $key, string $secret) {
        return $this->request('hic', array(
            'api' => $apiHost,
            'key' => $key,
            'sec' => $secret
        ));
    }

    public function login(string $un, string $pw) {
        return $this->request('login', array(
            'un' => $un,
            'pw' => $pw
        ));
    }

    public function logout() {
        return $this->request('logout', array());
    }

    public function totp(string $co, bool $r) {
        return $this->request('totp', array(
            'co' => $co,
            'r' => $r
        ));
    }

    public function totpSetup(string $co, string $se, bool $r) {
        return $this->request('totp', array(
            'co' => $co,
            'se' => $se,
            'r' => $r
        ));
    }

    public function totpRemove() {
        return $this->request('-totp', array());
    }

    public function get(string $path, $query, $maxCacheAgeSecs = 0) {
        return $this->request('get', array(
            'p' => $path,
            'q' => $query,
            'c' => $maxCacheAgeSecs
        ));
    }

    public function delete(string $path, $query) {
        return $this->request('delete', array(
            'p' => $path,
            'q' => $query
        ));
    }

    public function post(string $path, $body, $query, $files) {
        return $this->request('post', array(
            'p' => $path,
            'b' => $body,
            'q' => $query,
            'f' => $files
        ));
    }

    public function put(string $path, $body, $query, $files) {
        return $this->request('put', array(
            'p' => $path,
            'b' => $body,
            'q' => $query,
            'f' => $files
        ));
    }

    public function patch(string $path, $body, $query, $files) {
        return $this->request('patch', array(
            'p' => $path,
            'b' => $body,
            'q' => $query,
            'f' => $files
        ));
    }

    public function hasPerms($perms) {
        return $this->request('perms', array(
            'p' => $perms
        ));
    }

    public function hasCodeholderFields($fields) {
        return $this->request('permscf', array(
            'f' => $fields
        ));
    }

    public function hasOwnCodeholderFields($fields) {
        return $this->request('permsocf', array(
            'f' => $fields
        ));
    }

    public function matchRegExp($re, $str) {
        return $this->request('regexp', array(
            'r' => $re,
            's' => $str
        ));
    }

    public function evalScript(array $stack, array $vars, array $expr) {
        return $this->request('asc', array(
            's' => $stack,
            'fv' => $vars,
            'e' => $expr
        ));
    }

    public function convertCurrency(array $rates, string $f, string $t, float $val) {
        return $this->request('convertCurrency', array(
            'r' => $rates,
            'fc' => $f,
            'tc' => $t,
            'v' => $val
        ));
    }

    public function currencies() {
        return $this->request('currencies', array());
    }
}
