/*
This file is part of the Notesnook project (https://notesnook.com/)

Copyright (C) 2023 Streetwriters (Private) Limited

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/

// The Mac Catalyst slice of OpenPGPBridge.xcframework (react-native-fast-openpgp)
// references these Go runtime hooks without defining them. The iOS slice ships
// them as empty functions (Go's runtime/cgo gcc_signal_ios_nolldb.c), so the
// same empty definitions are provided here for Mac Catalyst only.
#include <TargetConditionals.h>

#if TARGET_OS_MACCATALYST
void darwin_arm_init_thread_exception_port_fastopenpgp(void) {}
void darwin_arm_init_mach_exception_handler_fastopenpgp(void) {}
#endif
