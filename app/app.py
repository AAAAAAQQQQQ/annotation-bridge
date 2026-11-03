#!/usr/bin/env python3
"""
标注投递.app —— annotation-bridge 的桌面启动器（PyObjC / AppKit 菜单栏）

菜单栏常驻：
  · 显示本地服务状态（绿点=运行且扩展已连接，橙点=运行但扩展没连，灰点=停了）
  · 一键启动 / 停止 / 重启服务
  · 一键让 Chrome 里的扩展弹出「独立面板窗口」
  · 登录时自动启动、打开日志、打开项目目录、重装原生宿主

命令行模式（方便脚本化和测试）：
  AnnotationBridge --status | --start | --stop | --restart | --open-panel | --selftest

配置（可选，放这儿就能复用去带别的本地服务）：
  ~/Library/Application Support/AnnotationBridge/config.json
  {"name":"标注投递","port":47391,"projectDir":"~/Project/annotation-bridge",
   "entry":"bridge.mjs","hostName":"com.gjr.annotation_bridge",
   "logPath":"~/Library/Logs/annotation-bridge.log"}
"""

import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

SHELL_PATH = "/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
HOME = os.path.expanduser("~")
APP_LOG = os.path.join(HOME, "Library/Logs/annotation-bridge-app.log")


def alog(msg):
    try:
        with open(APP_LOG, "a") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + str(msg) + "\n")
    except Exception:
        pass

# ── 配置 ─────────────────────────────────────────────


def expand(p):
    return os.path.expanduser(p)


class Settings:
    def __init__(self):
        self.name = "信鸽"
        self.port = 47391
        self.project_dir = expand("~/Project/annotation-bridge")
        self.entry = "bridge.mjs"
        self.host_name = "com.gjr.annotation_bridge"
        self.log_path = expand("~/Library/Logs/annotation-bridge.log")
        cfg = os.path.join(HOME, "Library/Application Support/AnnotationBridge/config.json")
        try:
            with open(cfg) as f:
                o = json.load(f)
            self.name = o.get("name", self.name)
            self.port = int(o.get("port", self.port))
            self.project_dir = expand(o.get("projectDir", self.project_dir))
            self.entry = o.get("entry", self.entry)
            self.host_name = o.get("hostName", self.host_name)
            self.log_path = expand(o.get("logPath", self.log_path))
        except Exception:
            pass

    @property
    def base_url(self):
        return "http://127.0.0.1:%d" % self.port

    @property
    def bridge_file(self):
        return os.path.join(self.project_dir, self.entry)


# ── HTTP（绕过系统代理，始终直连本机）──────────────────

_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def http_json(url, method="GET", timeout=1.5):
    req = urllib.request.Request(url, method=method)
    with _OPENER.open(req, timeout=timeout) as r:
        return json.loads(r.read().decode("utf-8"))


def health(s=None, timeout=1.5):
    s = s or Settings()
    try:
        h = http_json(s.base_url + "/health", timeout=timeout)
        return h if h.get("ok") else None
    except Exception:
        return None


def pending_count(s=None):
    s = s or Settings()
    try:
        return sum(http_json(s.base_url + "/queue/summary", timeout=1.2).get("counts", {}).values())
    except Exception:
        return 0


# ── 服务控制 ─────────────────────────────────────────


def shq(x):
    return "'" + str(x).replace("'", "'\\''") + "'"


def find_node():
    for c in ("/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"):
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    out = subprocess.run(["/bin/sh", "-c", "PATH=%s command -v node" % SHELL_PATH],
                         capture_output=True, text=True)
    return out.stdout.strip() or None


def start_bridge(s):
    if not os.path.isfile(s.bridge_file):
        return False
    node = find_node()
    if not node:
        return False
    cmd = "cd %s && PATH=%s nohup %s %s >> %s 2>&1 &" % (
        shq(s.project_dir), SHELL_PATH, shq(node), shq(s.entry), shq(s.log_path))
    subprocess.Popen(["/bin/sh", "-c", cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(24):
        time.sleep(0.25)
        if health(s):
            return True
    return False


def stop_bridge(s):
    try:
        http_json(s.base_url + "/shutdown", method="POST", timeout=2)
    except Exception:
        pass
    time.sleep(0.4)
    if health(s):
        subprocess.run(["/bin/sh", "-c", "pkill -f %s" % shq(s.bridge_file)],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        time.sleep(0.3)
    return health(s) is None


def _post_open(s):
    try:
        return http_json(s.base_url + "/open-panel", method="POST", timeout=3)
    except Exception as e:
        return {"ok": False, "error": str(e)}


def open_panel(s):
    """唤起面板。扩展没连上时先拉起 Chrome，再补发一次命令。"""
    if not health(s):
        start_bridge(s)
    r = _post_open(s)
    if r.get("ok") and not r.get("extension"):
        subprocess.Popen(["open", "-a", "Google Chrome"],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        for _ in range(12):
            time.sleep(0.5)
            if health(s) and health(s).get("extension"):
                break
        r = _post_open(s)
    return r


# ── 命令行 ───────────────────────────────────────────


def cli(flag, s):
    if flag == "--status":
        h = health(s)
        if h:
            h = dict(h)
            h["pending"] = pending_count(s)
            print(json.dumps(h, ensure_ascii=False, sort_keys=True))
        else:
            print(json.dumps({"ok": False, "port": s.port}))
            sys.exit(1)
    elif flag == "--start":
        print("started" if start_bridge(s) else "failed")
        sys.exit(0 if health(s) else 1)
    elif flag == "--stop":
        print("stopped" if stop_bridge(s) else "still running")
    elif flag == "--restart":
        stop_bridge(s)
        print("restarted" if start_bridge(s) else "failed")
        sys.exit(0 if health(s) else 1)
    elif flag == "--open-panel":
        print(json.dumps(open_panel(s), ensure_ascii=False))
    elif flag == "--selftest":
        selftest(s)
    else:
        print("usage: AnnotationBridge [--status|--start|--stop|--restart|--open-panel|--selftest]")
        sys.exit(2)


# ── 图标 ─────────────────────────────────────────────

def status_symbol():
    """菜单栏主图标：SF Symbol，template 模式，明暗模式都自适应。"""
    from AppKit import NSImage
    img = NSImage.imageWithSystemSymbolName_accessibilityDescription_("bird.fill", "信鸽")
    if img is not None:
        img.setTemplate_(True)
    return img


def status_color(dot):
    from AppKit import NSColor
    return {"green": NSColor.systemGreenColor(),
            "orange": NSColor.systemOrangeColor()}.get(dot, NSColor.systemGrayColor())


def notify_once(text, title):
    """第一次启动提示一下图标在菜单栏，别让人找不到。12 小时内只弹一次。"""
    stamp = os.path.join(HOME, ".annotation-bridge", ".app-notified")
    try:
        if time.time() - os.path.getmtime(stamp) < 12 * 3600:
            return
    except OSError:
        pass
    try:
        subprocess.Popen(["/usr/bin/osascript", "-e",
                          'display notification "%s" with title "%s"' % (text, title)],
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.makedirs(os.path.dirname(stamp), exist_ok=True)
        open(stamp, "w").close()
    except Exception:
        pass


# ── GUI ─────────────────────────────────────────────

def gui(s, show_window=True):
    import objc
    from AppKit import (
        NSApplication, NSApplicationActivationPolicyRegular, NSAlert, NSBezierPath,
        NSColor, NSImage, NSImageSymbolConfiguration, NSMenu, NSMenuItem,
        NSStatusBar, NSVariableStatusItemLength,
        NSWorkspace, NSControlStateValueOn, NSControlStateValueOff,
        NSMakeRect, NSMakeSize,
    )
    from Foundation import NSTimer, NSObject, NSURL
    from PyObjCTools import AppHelper

    class MenuBarApp(NSObject):
        def init(self):
            self = objc.super(MenuBarApp, self).init()
            if self is None:
                return None
            self.settings = s
            self.health = None
            self.pending = 0
            self.ticks = 0
            self._polling = False
            self.manual_stop = False
            self._auto_at = 0
            self._starting = False
            self.status_item = None
            self.menu = None
            self._icons = {}
            self.window = None
            self.win_status = None
            self.win_meta = None
            self.win_ext = None
            self.win_login = None
            self.show_on_launch = True
            return self

        # 启动
        def applicationDidFinishLaunching_(self, _note):
            self.status_item = NSStatusBar.systemStatusBar().statusItemWithLength_(
                NSVariableStatusItemLength)
            self.status_item.button().setToolTip_(self.settings.name + " · 点菜单打开面板")
            self.menu = NSMenu.alloc().init()
            self.status_item.setMenu_(self.menu)
            self.apply_health(health(self.settings))
            self.render()
            if self.health is None:
                threading.Thread(target=self.boot_start, daemon=True).start()
            self.build_window()
            if self.show_on_launch:
                self.show_window()
            alog("GUI 启动，窗口和菜单栏图标已创建")
            NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
                2.0, self, "tick:", None, True)

        @objc.python_method
        def build_window(self):
            from AppKit import (NSWindow, NSTextField, NSButton, NSFont, NSColor,
                                NSWindowStyleMaskTitled, NSWindowStyleMaskClosable,
                                NSWindowStyleMaskMiniaturizable, NSBackingStoreBuffered,
                                NSBezelStyleRounded, NSSwitchButton, NSLineBreakByWordWrapping)
            w = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
                NSMakeRect(0, 0, 380, 356),
                NSWindowStyleMaskTitled | NSWindowStyleMaskClosable | NSWindowStyleMaskMiniaturizable,
                NSBackingStoreBuffered, False)
            w.setTitle_("信鸽")
            w.setReleasedWhenClosed_(False)
            w.center()
            cv = w.contentView()

            def label(text, rect, size=12, bold=False, color=None, wrap=False):
                l = NSTextField.alloc().initWithFrame_(rect)
                l.setStringValue_(text)
                l.setBezeled_(False); l.setDrawsBackground_(False)
                l.setEditable_(False); l.setSelectable_(False)
                l.setFont_(NSFont.boldSystemFontOfSize_(size) if bold else NSFont.systemFontOfSize_(size))
                if color is not None:
                    l.setTextColor_(color)
                l.cell().setLineBreakMode_(NSLineBreakByWordWrapping)
                l.cell().setWraps_(wrap)
                cv.addSubview_(l)
                return l

            def button(title, rect, action, key=None):
                b = NSButton.alloc().initWithFrame_(rect)
                b.setTitle_(title)
                b.setBezelStyle_(NSBezelStyleRounded)
                b.setTarget_(self)
                b.setAction_(action)
                if key:
                    b.setKeyEquivalent_(key)
                cv.addSubview_(b)
                return b

            label(self.settings.name, NSMakeRect(20, 308, 200, 24), size=17, bold=True)
            self.win_status = label("● 已停止", NSMakeRect(20, 280, 340, 20), size=13, bold=True)
            self.win_meta = label("端口 %d" % self.settings.port, NSMakeRect(20, 260, 340, 18), size=11,
                                  color=NSColor.secondaryLabelColor())
            self.win_ext = label("", NSMakeRect(20, 242, 340, 18), size=11,
                                 color=NSColor.secondaryLabelColor())

            button("打开标注面板", NSMakeRect(20, 188, 340, 38), "openPanel:", key="\r")
            button("启动服务", NSMakeRect(20, 146, 106, 32), "startAction:")
            button("停止服务", NSMakeRect(137, 146, 106, 32), "stopAction:")
            button("重启服务", NSMakeRect(254, 146, 106, 32), "restartAction:")

            button("打开日志", NSMakeRect(20, 106, 106, 30), "openLog:")
            button("项目目录", NSMakeRect(137, 106, 106, 30), "openProject:")
            self.win_login = NSButton.alloc().initWithFrame_(NSMakeRect(252, 106, 110, 30))
            self.win_login.setButtonType_(NSSwitchButton)
            self.win_login.setTitle_("登录自启")
            self.win_login.setTarget_(self)
            self.win_login.setAction_("toggleLogin:")
            self.win_login.setState_(1 if os.path.exists(self.login_plist()) else 0)
            cv.addSubview_(self.win_login)

            label("面板由 Chrome 扩展以独立窗口弹出。\n"
                  "菜单栏图标可能被系统挤掉，用 Dock 图标打开这个窗口就行。",
                  NSMakeRect(20, 46, 340, 44), size=10.5, color=NSColor.tertiaryLabelColor(), wrap=True)
            button("退出", NSMakeRect(300, 12, 60, 26), "quit:")

            self.window = w

        @objc.python_method
        def show_window(self):
            if self.window is not None:
                self.window.makeKeyAndOrderFront_(None)
                NSApplication.sharedApplication().activateIgnoringOtherApps_(True)

        def showWindow_(self, _sender):
            self.show_window()

        def applicationShouldHandleReopen_hasVisibleWindows_(self, _app, _has):
            self.show_window()
            return True

        @objc.python_method
        def boot_start(self):
            start_bridge(self.settings)
            self.poll_once()

        @objc.python_method
        def tick_now(self):
            self.poll_once()

        # 轮询（放到后台线程，菜单不会被网络卡住）
        def tick_(self, _timer):
            self.poll_once()

        @objc.python_method
        def poll_once(self):
            if self._polling:
                return
            self._polling = True
            self.ticks += 1
            threading.Thread(target=self._poll, daemon=True).start()

        @objc.python_method
        def _poll(self):
            try:
                h = health(self.settings)
                p = pending_count(self.settings) if (h and self.ticks % 3 == 0) else self.pending
                if h is None:
                    p = 0
                    if not self.manual_stop:
                        self._auto_start()
            finally:
                self._polling = False
            AppHelper.callAfter(self._apply, h, p)

        @objc.python_method
        def _auto_start(self):
            """服务意外挂了（比如被 pkill 了）自己拉回来；用户点「停止」时不打扰。"""
            if self._starting or time.time() - self._auto_at < 10:
                return
            self._auto_at = time.time()
            self._starting = True
            try:
                alog("服务不在，自动拉起")
                start_bridge(self.settings)
            finally:
                self._starting = False

        @objc.python_method
        def _apply(self, h, p):
            self.apply_health(h, p)
            self.render()

        @objc.python_method
        def apply_health(self, h, pending=None):
            self.health = h
            if pending is not None:
                self.pending = pending
            if h is None:
                self.pending = 0
            dot = "gray"
            if h is not None:
                dot = "green" if h.get("extension") else "orange"
            try:
                from AppKit import NSColor
                if self.win_status is not None:
                    color = {"green": NSColor.systemGreenColor(),
                             "orange": NSColor.systemOrangeColor()}.get(dot, NSColor.secondaryLabelColor())
                    self.win_status.setStringValue_("● " + self.state_text())
                    self.win_status.setTextColor_(color)
                if self.win_meta is not None:
                    hh = self.health
                    if hh:
                        txt = "端口 %d · pid %s · v%s" % (self.settings.port, hh.get("pid", "?"), hh.get("version", "?"))
                        if self.pending:
                            txt += " · 待发 %d 条" % self.pending
                    else:
                        txt = "端口 %d · 服务未运行" % self.settings.port
                    self.win_meta.setStringValue_(txt)
                if self.win_ext is not None and self.health is not None:
                    self.win_ext.setStringValue_("扩展：" + ("已连接" if self.health.get("extension") else "未连接（点一下 Chrome 的扩展图标）"))
            except Exception as e:
                alog("刷新窗口失败: %r" % (e,))
            try:
                from AppKit import NSFont, NSAttributedString, NSFontAttributeName, NSForegroundColorAttributeName
                btn = self.status_item.button()
                sym = status_symbol()
                if sym is not None and btn.image() is None:
                    btn.setImage_(sym)
                    btn.setImagePosition_(2)      # 图标在文字左边
                    btn.setImageScaling_(2)       # 等比缩小
                label = " ●" if sym is not None else "标注 ●"
                attrs = {
                    NSFontAttributeName: NSFont.systemFontOfSize_(9),
                    NSForegroundColorAttributeName: status_color(dot),
                }
                btn.setAttributedTitle_(NSAttributedString.alloc().initWithString_attributes_(label, attrs))
            except Exception as e:
                alog("设置图标失败: %r" % (e,))

        # 图标
        # 菜单
        @objc.python_method
        def render(self):
            try:
                self.build_menu()
            except Exception as e:
                alog("build_menu 失败: %r" % (e,))

        @objc.python_method
        def state_text(self):
            h = self.health
            if h is None:
                return "已停止"
            return "运行中 · 扩展已连接" if h.get("extension") else "运行中 · 扩展未连接"

        @objc.python_method
        def build_menu(self):
            m = self.menu
            m.removeAllItems()
            s = self.settings

            def add(title, action=None, key="", enabled=True, image=None, state=None):
                it = NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(title, action, key)
                it.setTarget_(self if action else None)
                it.setEnabled_(enabled)
                if image:
                    it.setImage_(NSImage.imageWithSystemSymbolName_accessibilityDescription_(image, None))
                if state is not None:
                    it.setState_(state)
                m.addItem_(it)
                return it

            add("%s · %s" % (s.name, self.state_text()), enabled=False)
            if self.health:
                h = self.health
                line = "端口 %d · pid %s · v%s" % (s.port, h.get("pid", "?"), h.get("version", "?"))
                if self.pending:
                    line += " · 待发 %d 条" % self.pending
                add(line, enabled=False)
                add("扩展：已连接" if h.get("extension") else "扩展：未连接（点一下扩展图标）", enabled=False)
            else:
                add("端口 %d · 服务未运行" % s.port, enabled=False)

            m.addItem_(NSMenuItem.separatorItem())
            add("打开控制面板", "showWindow:", image="slider.horizontal.3")
            add("打开标注面板", "openPanel:", "o", image="macwindow")
            m.addItem_(NSMenuItem.separatorItem())

            if self.health is None:
                add("启动服务", "startAction:", image="play.fill")
            else:
                add("停止服务", "stopAction:", image="stop.fill")
                add("重启服务", "restartAction:", image="arrow.clockwise")
            add("复制服务地址", "copyURL:", image="link")

            m.addItem_(NSMenuItem.separatorItem())
            add("打开日志", "openLog:", image="doc.text.magnifyingglass")
            add("打开项目目录", "openProject:", image="folder")
            add("重新安装原生宿主", "reinstallHost:", image="wrench.and.screwdriver")

            m.addItem_(NSMenuItem.separatorItem())
            on = os.path.exists(self.login_plist())
            add("登录时自动启动", "toggleLogin:", state=(NSControlStateValueOn if on else NSControlStateValueOff))

            m.addItem_(NSMenuItem.separatorItem())
            add("关于%s" % s.name, "showAbout:", image="info.circle")
            add("退出", "quit:", "q", image="power")

        # 动作
        def openPanel_(self, _sender):
            threading.Thread(target=self._open_panel_bg, daemon=True).start()

        @objc.python_method
        def _open_panel_bg(self):
            r = open_panel(self.settings)
            if r.get("ok") and r.get("extension"):
                return
            AppHelper.callAfter(self.alert, "扩展没有连上",
                "Chrome 里还没建立原生消息通道。\n\n"
                "确认这几件事：\n"
                "1. 扩展已加载（chrome://extensions）\n"
                "2. 原生宿主已安装（./install-native.sh）\n"
                "3. 安装后重启过 Chrome\n\n"
                "然后在 Chrome 工具栏点一下扩展图标。")

        def startAction_(self, _sender):
            self.manual_stop = False
            if not start_bridge(self.settings):
                self.alert("启动失败", "看看日志：\n" + self.settings.log_path)
            self.tick_now()

        def stopAction_(self, _sender):
            self.manual_stop = True
            stop_bridge(self.settings)
            self.tick_now()

        def restartAction_(self, _sender):
            self.manual_stop = False
            stop_bridge(self.settings)
            start_bridge(self.settings)
            self.tick_now()

        def copyURL_(self, _sender):
            from AppKit import NSPasteboard, NSPasteboardTypeString
            pb = NSPasteboard.generalPasteboard()
            pb.clearContents()
            pb.setString_forType_(self.settings.base_url, NSPasteboardTypeString)

        def openLog_(self, _sender):
            p = self.settings.log_path
            if not os.path.exists(p):
                open(p, "a").close()
            NSWorkspace.sharedWorkspace().openURL_(NSURL.fileURLWithPath_(p))

        def openProject_(self, _sender):
            NSWorkspace.sharedWorkspace().openURL_(NSURL.fileURLWithPath_(self.settings.project_dir))

        def reinstallHost_(self, _sender):
            script = os.path.join(self.settings.project_dir, "install-native.sh")
            r = subprocess.run(["/bin/bash", script], capture_output=True, text=True,
                               cwd=self.settings.project_dir)
            self.alert("原生宿主已重新安装" if r.returncode == 0 else "安装失败（%d）" % r.returncode,
                       (r.stdout + r.stderr).strip() or "完成")

        @objc.python_method
        def login_plist(self):
            return os.path.join(HOME, "Library/LaunchAgents/com.gjr.annotation-bridge.gui.plist")

        def toggleLogin_(self, _sender):
            p = self.login_plist()
            if os.path.exists(p):
                subprocess.run(["/bin/sh", "-c", "launchctl bootout gui/%d/com.gjr.annotation-bridge.gui 2>/dev/null" % os.getuid()])
                os.remove(p)
                if self.win_login is not None:
                    self.win_login.setState_(0)
                return
            exe = os.path.abspath(sys.argv[0])
            plist = (
                '<?xml version="1.0" encoding="UTF-8"?>\n'
                '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" '
                '"http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
                '<plist version="1.0"><dict>\n'
                '  <key>Label</key><string>com.gjr.annotation-bridge.gui</string>\n'
                '  <key>ProgramArguments</key><array><string>%s</string><string>--quiet</string></array>\n'
                '  <key>RunAtLoad</key><true/>\n'
                '  <key>KeepAlive</key><false/>\n'
                '</dict></plist>\n' % exe
            )
            os.makedirs(os.path.dirname(p), exist_ok=True)
            with open(p, "w") as f:
                f.write(plist)
            subprocess.run(["/bin/sh", "-c", "launchctl bootstrap gui/%d %s 2>&1" % (os.getuid(), shq(p))],
                           capture_output=True)
            if self.win_login is not None:
                self.win_login.setState_(1)
            self.render()

        @objc.python_method
        def alert(self, title, text):
            a = NSAlert.alloc().init()
            a.setMessageText_(title)
            a.setInformativeText_(text)
            a.addButtonWithTitle_("好")
            a.runModal()

        def showAbout_(self, _sender):
            s = self.settings
            self.alert(s.name + " · 桌面启动器",
                       "服务：%s\n项目：%s\n\n面板由 Chrome 扩展以独立窗口弹出。\n"
                       "命令行：--status / --start / --stop / --restart / --open-panel"
                       % (s.base_url, s.project_dir))

        def quit_(self, _sender):
            NSApplication.sharedApplication().terminate_(None)

    from AppKit import NSMenu, NSMenuItem
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyRegular)
    # 有 Dock 图标就得有个主菜单，否则 ⌘Q 不退
    main_menu = NSMenu.alloc().init()
    app_item = NSMenuItem.alloc().init()
    main_menu.addItem_(app_item)
    app_menu = NSMenu.alloc().init()
    app_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("关于标注投递", "showAbout:", ""))
    app_menu.addItem_(NSMenuItem.separatorItem())
    app_menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_("退出标注投递", "terminate:", "q"))
    app_item.setSubmenu_(app_menu)
    app.setMainMenu_(main_menu)

    delegate = MenuBarApp.alloc().init()
    delegate.show_on_launch = bool(show_window)
    app.setDelegate_(delegate)
    # 持有引用，防止被 GC
    globals()["_delegate"] = delegate
    AppHelper.runEventLoop()


def selftest(s):
    """构建一次菜单并打印，确认 AppKit 这条链路是通的（不开窗口）。"""
    from AppKit import (NSApplication, NSApplicationActivationPolicyAccessory, NSStatusBar,
                        NSVariableStatusItemLength, NSMenu, NSMenuItem)
    app = NSApplication.sharedApplication()
    app.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    item = NSStatusBar.systemStatusBar().statusItemWithLength_(NSVariableStatusItemLength)
    menu = NSMenu.alloc().init()
    for name in ("状态", "打开标注面板", "启动服务", "打开日志", "退出"):
        menu.addItem_(NSMenuItem.alloc().initWithTitle_action_keyEquivalent_(name, None, ""))
    item.setMenu_(menu)
    titles = [menu.itemAtIndex_(i).title() for i in range(menu.numberOfItems())]
    sym = status_symbol()
    print(json.dumps({"ok": True, "menu": titles, "health": health(s),
                      "symbol": sym is not None,
                      "symbolSize": [sym.size().width, sym.size().height] if sym is not None else None},
                     ensure_ascii=False))
    NSStatusBar.systemStatusBar().removeStatusItem_(item)


def main():
    s = Settings()
    args = [a for a in sys.argv[1:] if a.startswith("--")]
    quiet = "--quiet" in args
    args = [a for a in args if a != "--quiet"]
    if args:
        cli(args[0], s)
        return
    gui(s, show_window=not quiet)


if __name__ == "__main__":
    main()
