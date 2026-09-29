#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(VeyraNMenuButtonManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(menuItems, NSArray)
RCT_EXPORT_VIEW_PROPERTY(menuTitle, NSString)
RCT_EXPORT_VIEW_PROPERTY(accessibilityTitle, NSString)
RCT_EXPORT_VIEW_PROPERTY(onSelectItem, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(deferred, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onMenuRequest, RCTBubblingEventBlock)

@end

@interface RCT_EXTERN_MODULE(VeyraNContextMenuManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(menuItems, NSArray)
RCT_EXPORT_VIEW_PROPERTY(menuTitle, NSString)
RCT_EXPORT_VIEW_PROPERTY(previewCornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(onSelectItem, RCTBubblingEventBlock)
RCT_EXPORT_VIEW_PROPERTY(deferred, BOOL)
RCT_EXPORT_VIEW_PROPERTY(menuEnabled, BOOL)
RCT_EXPORT_VIEW_PROPERTY(onMenuRequest, RCTBubblingEventBlock)

@end
