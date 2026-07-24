package main

/*
#include <stdlib.h>
*/
import "C"

import (
	"os"
)

//export RcloneSyncEnv
func RcloneSyncEnv(key *C.char) {
	goKey := C.GoString(key)
	cVal := C.getenv(key)
	if cVal != nil {
		os.Setenv(goKey, C.GoString(cVal))
	}
}
