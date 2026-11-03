#!/usr/bin/env python3
"""
生成「信鸽」的图标：蓝白配色，圆角方块 + 白色鸽子。
用法：python3 app/make_icon.py [输出.png] [--symbol bird.fill] [--no-badge]
"""
import sys
import objc
from AppKit import (
    NSView, NSColor, NSBezierPath, NSMakeRect, NSMakeSize, NSGradient,
    NSImage, NSImageSymbolConfiguration, NSFont, NSShadow,
)

SIZE = 1024


def color(hexstr, alpha=1.0):
    h = hexstr.lstrip('#')
    r, g, b = int(h[0:2], 16) / 255.0, int(h[2:4], 16) / 255.0, int(h[4:6], 16) / 255.0
    return NSColor.colorWithCalibratedRed_green_blue_alpha_(r, g, b, alpha)


class IconView(NSView):
    symbol = "bird.fill"
    badge = True

    def isFlipped(self):
        return False

    def drawRect_(self, rect):
        b = self.bounds()
        # 圆角底：蓝到浅蓝的斜向渐变
        radius = b.size.width * 0.2237
        path = NSBezierPath.bezierPathWithRoundedRect_xRadius_yRadius_(b, radius, radius)
        path.addClip()
        grad = NSGradient.alloc().initWithStartingColor_endingColor_(
            color('#4C8DFF'), color('#1D4ED8'))
        grad.drawInRect_angle_(b, -75)

        # 白色鸽子
        sym = NSImage.imageWithSystemSymbolName_accessibilityDescription_(self.symbol, None)
        if sym is not None:
            cfg = NSImageSymbolConfiguration.configurationWithPaletteColors_([NSColor.whiteColor()])
            sym = sym.imageWithSymbolConfiguration_(cfg) or sym
            w, h = sym.size()
            scale = min(b.size.width * 0.66 / w, b.size.height * 0.66 / h)
            dw, dh = w * scale, h * scale
            x = (b.size.width - dw) / 2 + (-b.size.width * 0.03 if self.badge else 0)
            y = (b.size.height - dh) / 2 + (b.size.height * 0.03 if self.badge else 0)
            shadow = NSShadow.alloc().init()
            shadow.setShadowOffset_(NSMakeSize(0, -b.size.height * 0.012))
            shadow.setShadowBlurRadius_(b.size.height * 0.03)
            shadow.setShadowColor_(NSColor.colorWithCalibratedWhite_alpha_(0.0, 0.22))
            shadow.set()
            sym.drawInRect_(NSMakeRect(x, y, dw, dh))
            NSShadow.alloc().init().set()

        if self.badge:
            # 右下角白色圆底 + 蓝色小信封：信鸽带着消息
            env = NSImage.imageWithSystemSymbolName_accessibilityDescription_("envelope.fill", None)
            if env is not None:
                cfg = NSImageSymbolConfiguration.configurationWithPaletteColors_([color('#1D4ED8')])
                env = env.imageWithSymbolConfiguration_(cfg) or env
                w, h = env.size()
                scale = min(b.size.width * 0.15 / w, b.size.height * 0.15 / h)
                dw, dh = w * scale, h * scale
                cx = b.size.width * 0.705
                cy = b.size.height * 0.245
                r = b.size.width * 0.135
                NSColor.whiteColor().set()
                NSBezierPath.bezierPathWithOvalInRect_(
                    NSMakeRect(cx - r, cy - r, r * 2, r * 2)).fill()
                env.drawInRect_(NSMakeRect(cx - dw / 2, cy - dh / 2, dw, dh))


def render(path, symbol="bird.fill", badge=True):
    import AppKit
    app = AppKit.NSApplication.sharedApplication()
    v = IconView.alloc().initWithFrame_(NSMakeRect(0, 0, SIZE, SIZE))
    v.symbol = symbol
    v.badge = badge
    v.setWantsLayer_(True)
    rep = v.bitmapImageRepForCachingDisplayInRect_(v.bounds())
    v.cacheDisplayInRect_toBitmapImageRep_(v.bounds(), rep)
    data = rep.representationUsingType_properties_(4, {})   # 4 = PNG
    with open(path, "wb") as f:
        f.write(bytes(data))
    print("wrote", path)


if __name__ == "__main__":
    out = sys.argv[1] if len(sys.argv) > 1 else "/tmp/ximge.png"
    symbol = "bird.fill"
    badge = True
    if "--symbol" in sys.argv:
        symbol = sys.argv[sys.argv.index("--symbol") + 1]
    if "--no-badge" in sys.argv:
        badge = False
    render(out, symbol, badge)
