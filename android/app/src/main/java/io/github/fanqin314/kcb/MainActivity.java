package io.github.fanqin314.kcb;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

/**
 * 课程表 WebView 壳：直接加载 GitHub Pages 上的课程表页面。
 * 电脑端同步后会把新的 kcb-data.js 推到仓库，手机端重新打开应用即可看到新课表，
 * 因此壳里不打包任何课表数据，也不包含同步控制台。
 */
public class MainActivity extends Activity {

    /*
     * 直接指向课程表页本身，而不是站点根目录：
     * 根目录的 index.html 是靠 meta refresh 跳到「课程表.html」的，
     * 从首页跳转会留下一条历史记录，按返回键就会回到首页再被跳回来，
     * 等于永远退不出应用。这里用百分号编码，避免源码中文字符编码问题。
     */
    private static final String START_URL =
            "https://fanqin314.github.io/kcb-course-schedule/%E8%AF%BE%E7%A8%8B%E8%A1%A8.html";
    private static final String SITE_HOST = "fanqin314.github.io";

    private WebView web;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        web = new WebView(this);
        web.setBackgroundColor(Color.parseColor("#EDE3D1"));

        WebSettings settings = web.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri url = request.getUrl();
                if (url == null) return false;
                if (SITE_HOST.equals(url.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, url));
                } catch (Exception ignored) {
                    /* 没有可处理的应用时留在原地即可 */
                }
                return true;
            }
        });
        web.setWebChromeClient(new WebChromeClient());

        setContentView(web);

        if (state != null) {
            web.restoreState(state);
        } else {
            web.loadUrl(START_URL);
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle out) {
        super.onSaveInstanceState(out);
        if (web != null) web.saveState(out);
    }

    @Override
    protected void onPause() {
        if (web != null) web.onPause();
        super.onPause();
    }

    @Override
    protected void onResume() {
        if (web != null) web.onResume();
        super.onResume();
    }

    @Override
    protected void onDestroy() {
        if (web != null) {
            web.loadUrl("about:blank");
            web.destroy();
            web = null;
        }
        super.onDestroy();
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        if (web != null && web.canGoBack()) {
            web.goBack();
        } else {
            super.onBackPressed();
        }
    }
}
