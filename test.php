<?php
$ipc_ports = [];
foreach (scandir("aksobridge") as $filename) {
    if (strpos($filename, "ipc") === 0) {
        $ipc_ports[] = "aksobridge/" . $filename;
    }
}
// TODO: better scheduling mechanism
$ipc_index = rand(0, count($ipc_ports) - 1);
$ipc_name = $ipc_ports[$ipc_index];
echo $ipc_name . "\n";
$fp = fsockopen("unix://./" . $ipc_name);
fwrite($fp, "abx1\x06\0\0\0\x81\xa3\x63\x61\x74\xc3");
echo fgets($fp);
