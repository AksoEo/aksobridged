<?php
$ipc_ports = [];
foreach (scandir(".") as $filename) {
    if (strpos($filename, "ipc") === 0) {
        $ipc_ports[] = $filename;
    }
}
// TODO: better scheduling mechanism
$ipc_index = rand(0, count($ipc_ports) - 1);
echo $ipc_index;
$ipc_name = $ipc_ports[$ipc_index];
echo $ipc_name;
$fp = fsockopen("unix://./" . $ipc_name);
fwrite($fp, "hello world\n");
echo fgets($fp);
