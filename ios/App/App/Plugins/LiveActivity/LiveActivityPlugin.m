// SPDX-License-Identifier: Apache-2.0
#import <Capacitor/Capacitor.h>
CAP_PLUGIN(LiveActivity, "LiveActivity",
    CAP_PLUGIN_METHOD(startActivity, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(updateActivity, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(endActivity, CAPPluginReturnPromise);
)
