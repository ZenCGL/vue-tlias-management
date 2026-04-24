package com.server.faceservice.service;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.server.faceservice.utils.ModelWebsocket;
import com.server.faceservice.utils.SafeWebSocketSender;
import jakarta.annotation.PostConstruct;
import org.bytedeco.ffmpeg.global.avutil;
import org.bytedeco.javacv.FFmpegFrameGrabber;
import org.bytedeco.javacv.FFmpegFrameRecorder;
import org.bytedeco.javacv.Frame;
import org.bytedeco.javacv.Java2DFrameConverter;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.util.Base64;
import java.util.Map;
import java.util.concurrent.*;


@Service
public class FaceDetectService {
    @Autowired
    ModelWebsocket modelWebsocket;

    private SafeWebSocketSender sender;
    private final Semaphore frameSemaphore = new Semaphore(30);
    private final Executor frameProcessingExecutor = Executors.newFixedThreadPool(
            Runtime.getRuntime().availableProcessors() * 2
    );

    @PostConstruct
    public void init() {
        avutil.av_log_set_level(avutil.AV_LOG_ERROR);
        sender = new SafeWebSocketSender(modelWebsocket);
    }
    public boolean isConnected(){
        return modelWebsocket.isConnected;
    }
    private void sendFrame(byte[] frameData, String userId) {
        String base64Image = Base64.getEncoder().encodeToString(frameData);

        // 创建 JSON 消息
        ObjectMapper objectMapper = new ObjectMapper();
        try {
            String jsonMessage = objectMapper.writeValueAsString(Map.of("userId", userId, "frame", base64Image));

            // 发送消息
            sender.sendAsync(jsonMessage.getBytes());
        } catch (JsonProcessingException e) {
            e.printStackTrace();
        }
    }
    public void processVideo(String rtspUrl, String userId) throws Exception {
        try (FFmpegFrameGrabber grabber = new FFmpegFrameGrabber(rtspUrl)) {
            grabber.setOption("rtsp_transport", "tcp");

            // 2. 设置超时时间（防止网络波动导致程序卡死，单位：微秒）
            grabber.setOption("stimeout", "5000000"); // 5秒超时

            // 3. 优化缓冲区（减少花屏）
            grabber.setOption("buffer_size", "10485760"); // 10MB 缓冲区
            grabber.setVideoOption("autorotate", "1");
            //将视频处理为一帧一帧的图片，发送给模型处理
            grabber.start();
            if (grabber.grabImage()==null) {
                throw new Exception("Failed to grab the first frame from the video stream.");
            }
            Frame frame;
            int i = 0;
            while ((frame = grabber.grab()) != null ) {
                if (i < 30){
                    //抽帧
                    i = i + 1;
                    continue;
                }
                i=0;
                if (frame.image != null) {
                    final Frame finalFrame = frame.clone();
                    frameProcessingExecutor.execute(() -> {
                        //异步并行处理,但可能产生异常
                        try {
                            frameSemaphore.acquire();
                            byte[] imageBytes = convertFrameToJpeg(finalFrame);
                            sendFrame(imageBytes, userId);
                        } catch (IOException e) {
                            // 处理异常
                        } catch (InterruptedException e) {
                            throw new RuntimeException(e);
                        }
                        finally {
                            frameSemaphore.release();
                        }
                    });
                }
            }

        }
        catch (FFmpegFrameGrabber.Exception e) {
            // 针对 RTSP 连接失败的专门异常处理
            System.err.println("RTSP Stream Error: " + e.getMessage());
            throw e;
        }
    }
    @SuppressWarnings("all")
    private byte[] convertFrameToJpeg(Frame frame) throws IOException {
        Java2DFrameConverter converter = new Java2DFrameConverter();
        BufferedImage image = converter.getBufferedImage(frame);

        // 检查像素格式是否为过时的格式（例如 yuvj420p）
        boolean isDeprecatedFormat = isDeprecatedPixelFormat(image);

        if (isDeprecatedFormat) {
            // 如果是过时的像素格式，进行转换
            BufferedImage convertedImage = convertToModernFormat(image);
            image = convertedImage;
        }

        // 将图像转换为 JPEG 字节数组
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        ImageIO.write(image, "jpg", baos);
        return baos.toByteArray();
    }
    private boolean isDeprecatedPixelFormat(BufferedImage image) {
        // 检查图像类型是否为过时的格式
        // 例如，TYPE_3BYTE_BGR 是常见的现代格式
        return image.getType() != BufferedImage.TYPE_3BYTE_BGR &&
                image.getType() != BufferedImage.TYPE_INT_RGB;
    }
    private BufferedImage convertToModernFormat(BufferedImage image) {
        // 创建一个新的 BufferedImage，使用现代的像素格式
        BufferedImage convertedImage = new BufferedImage(
                image.getWidth(),
                image.getHeight(),
                BufferedImage.TYPE_3BYTE_BGR
        );
        // 将原始图像绘制到新图像上
        convertedImage.getGraphics().drawImage(image, 0, 0, null);
        return convertedImage;
    }

}
