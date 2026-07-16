# 目前 release 未开启 minify（build.gradle 里 minifyEnabled false），此文件留空占位。
# 若日后开启混淆，需保留 @JavascriptInterface 方法不被裁剪：
# -keepclassmembers class com.syncwatch.app.NativeBridge {
#     @android.webkit.JavascriptInterface <methods>;
# }
