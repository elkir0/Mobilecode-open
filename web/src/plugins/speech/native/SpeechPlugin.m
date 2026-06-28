// SPDX-License-Identifier: Apache-2.0
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(Speech, "Speech",
    CAP_PLUGIN_METHOD(start, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(stop, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(isSupported, CAPPluginReturnPromise);
)
