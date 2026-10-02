#import <React/RCTViewManager.h>

@interface RCT_EXTERN_MODULE(VeyraNGlassViewManager, RCTViewManager)

RCT_EXPORT_VIEW_PROPERTY(cornerRadius, CGFloat)
RCT_EXPORT_VIEW_PROPERTY(variant, NSString)
RCT_EXPORT_VIEW_PROPERTY(interactive, BOOL)
RCT_EXPORT_VIEW_PROPERTY(tint, UIColor)
RCT_EXPORT_VIEW_PROPERTY(dark, BOOL)

@end
