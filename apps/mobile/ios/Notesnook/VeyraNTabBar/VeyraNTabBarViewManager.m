#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(VeyraNTabBarViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(selectedSection, NSString)
RCT_EXPORT_VIEW_PROPERTY(onSelect, RCTBubblingEventBlock)

@end
