<?php
include 'php/vendor/autoload.php';
include 'php/src/AksoBridge.php';

$bridge = new AksoBridge("aksobridge");
$state = $bridge->open("https://apitest.akso.org", "127.0.0.1", array());

$un = "teeest";
$pw = "test";
echo "logging in as teeest...\n";
var_dump($bridge->login($un, $pw));

var_dump($bridge->get('codeholders/self', array(
    'fields' => 'firstNameLegal,lastNameLegal'
)));

echo "getting lists/public\n";
$lists = $bridge->get('/lists/public', array(
    'offset' => 0,
    'limit' => 10,
    'fields' => ['id', 'name', 'description']
), 1);
var_dump($lists);

$bridge->close();
var_dump($bridge->setCookies);
