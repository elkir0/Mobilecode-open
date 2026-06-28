// SPDX-License-Identifier: Apache-2.0
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(SharedSnapshot, "SharedSnapshot",
    CAP_PLUGIN_METHOD(writeSnapshot, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(readSnapshot, CAPPluginReturnPromise);
)
