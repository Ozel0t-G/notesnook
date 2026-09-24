#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(TaskSymbolViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(symbolName, NSString)
RCT_EXPORT_VIEW_PROPERTY(symbolColor, UIColor)

@end
