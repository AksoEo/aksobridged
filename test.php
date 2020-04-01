<?php
include 'php/vendor/autoload.php';
include 'php/src/AksoBridge.php';

$bridge = new AksoBridge("aksobridge");
$state = $bridge->open("127.0.0.1", array());

$un = "teeest";
$pw = "test";
echo "logging in as teeest...\n";
var_dump($bridge->login($un, $pw));

var_dump($bridge->get('codeholders/self', array(
    'fields' => 'firstNameLegal,lastNameLegal'
)));

$bridge->close();
var_dump($bridge->setCookies);
