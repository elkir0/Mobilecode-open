// SPDX-License-Identifier: Apache-2.0
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(OpenCodeSSE, "OpenCodeSSE",
    CAP_PLUGIN_METHOD(connect, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(disconnect, CAPPluginReturnPromise);
)
