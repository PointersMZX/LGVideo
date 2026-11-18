package com.lg.video;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(VoidBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
