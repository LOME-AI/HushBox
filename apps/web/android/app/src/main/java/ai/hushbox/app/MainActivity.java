package ai.hushbox.app;

import android.os.Bundle;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.WebView;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    private static final int MAX_RENDERER_RECOVERIES = 3;

    /**
     * Static because the counter has to outlive the Activity it is counting for.
     * recreate() constructs a new MainActivity, so an instance field would read
     * zero on every recovery and bound nothing. Only the death of the app process
     * clears this — which is exactly the cold start that ends a crash loop, and is
     * what the exhausted branch below asks Android for. Nothing else resets it: not
     * recreate(), not a configuration change, not backgrounding, and no elapsed
     * quiet period, because a device that recovers three renderers in one process
     * lifetime is one worth restarting whether the deaths were seconds or hours
     * apart. Touched only from the UI thread, where WebView callbacks arrive.
     */
    private static int rendererRecoveries = 0;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Registered on the builder before super.onCreate builds the bridge, so the
        // listener is attached before the WebView loads anything and cannot miss an
        // early renderer death.
        bridgeBuilder.addWebViewListener(
            new WebViewListener() {
                @Override
                public boolean onRenderProcessGone(WebView webView, RenderProcessGoneDetail detail) {
                    if (rendererRecoveries >= MAX_RENDERER_RECOVERIES) {
                        // The default answer, which tells Android to kill the app process.
                        // A renderer failing this reliably will fail the next one too, and
                        // a death the user can see and act on beats a crash-and-recreate
                        // loop that drains the battery and never settles.
                        return false;
                    }

                    rendererRecoveries++;

                    // true tells Android to spare the app process, which by itself only
                    // buys a permanently unusable WebView — a renderer is bound to a
                    // WebView for its lifetime. A fresh Activity is what gets a live one.
                    recreate();
                    return true;
                }
            }
        );

        super.onCreate(savedInstanceState);
    }
}
