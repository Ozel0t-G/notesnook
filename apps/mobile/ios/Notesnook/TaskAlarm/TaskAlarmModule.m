#import <React/RCTBridgeModule.h>

@interface RCT_EXTERN_MODULE(TaskAlarmModule, NSObject)

RCT_EXTERN_METHOD(status:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(requestAuthorization:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(replaceAlarms:(NSString *)accountId
                  accountScope:(NSString *)accountScope
                  alarms:(NSArray *)alarms
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(verifyAlarms:(NSString *)accountId
                  alarmKeys:(NSArray *)alarmKeys
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelScheduledAlarms:(NSString *)accountId
                  alarmKeys:(NSArray *)alarmKeys
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(cancelAll:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(syncOverdueActivities:(NSString *)accountId
                  activities:(NSArray *)activities
                  privacyHidden:(BOOL)privacyHidden
                  accountScope:(NSString *)accountScope
                  resolver:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

RCT_EXTERN_METHOD(endOverdueActivities:(RCTPromiseResolveBlock)resolve
                  rejecter:(RCTPromiseRejectBlock)reject)

@end
