package com.server.faceservice.utils;

import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

public class SafeWebSocketSender {
    private static final Logger LOGGER = LoggerFactory.getLogger(SafeWebSocketSender.class);
    private final BlockingQueue<byte[]> messageQueue = new LinkedBlockingQueue<>(1000);
    private final ModelWebsocket websocket;
    private volatile boolean running = true;

    public SafeWebSocketSender(ModelWebsocket websocket) {
        if(websocket == null){
            LOGGER.error("FaceDetectService initialized with modelWebsocket: {}", websocket);
        }
        this.websocket = websocket;
        websocket.connect();
        startConsumer();
    }

    private void startConsumer() {
        Thread consumerThread = new Thread(() -> {
            while (running) {
                try {
                    byte[] data = messageQueue.poll(100, TimeUnit.MILLISECONDS);
                    if (data != null && websocket.isOpen()) {
                        synchronized (websocket) {
                            websocket.send(data);
                        }
                    }
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        });
        consumerThread.setDaemon(true);
        consumerThread.start();
    }

    public void sendAsync(byte[] data) {
        if (!messageQueue.offer(data)) {
            // 处理队列满的情况（如丢弃旧帧或等待空间）
            messageQueue.poll();
        }
    }

    @PreDestroy
    public void shutdown() {
        running = false;
    }
}
