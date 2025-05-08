import { errorHandling, telemetryData } from "../../utils/middleware";

export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        await errorHandling(context);
        telemetryData(context);

        // 检查是否有KV存储可用
        if (!env.img_url) {
            return new Response(
                JSON.stringify({ error: "KV storage not configured" }),
                {
                    status: 500,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        // 解析请求数据
        const formData = await request.formData();
        const files = formData.getAll('files');
        
        if (!files || files.length === 0) {
            throw new Error('No files uploaded');
        }

        // 处理结果数组
        const results = [];
        const errors = [];

        // 并行处理所有文件上传
        const uploadPromises = files.map(async (file) => {
            try {
                const fileName = file.name;
                const fileExtension = fileName.split('.').pop().toLowerCase();
                const telegramFormData = new FormData();
                telegramFormData.append("chat_id", env.TG_Chat_ID);

                // 根据文件类型选择合适的上传方式
                let apiEndpoint;
                if (file.type.startsWith('image/')) {
                    telegramFormData.append("photo", file);
                    apiEndpoint = 'sendPhoto';
                } else if (file.type.startsWith('audio/')) {
                    telegramFormData.append("audio", file);
                    apiEndpoint = 'sendAudio';
                } else if (file.type.startsWith('video/')) {
                    telegramFormData.append("video", file);
                    apiEndpoint = 'sendVideo';
                } else {
                    telegramFormData.append("document", file);
                    apiEndpoint = 'sendDocument';
                }

                const result = await sendToTelegram(telegramFormData, apiEndpoint, env);
                if (!result.success) {
                    throw new Error(result.error);
                }

                const fileId = getFileId(result.data);

                if (!fileId) {
                    throw new Error('Failed to get file ID');
                }

                // 将文件信息保存到 KV 存储
                await env.img_url.put(`${fileId}.${fileExtension}`, "", {
                    metadata: {
                        TimeStamp: Date.now(),
                        ListType: "None",
                        Label: "None",
                        liked: false,
                        fileName: fileName,
                        fileSize: file.size,
                        batchUpload: true
                    }
                });

                // 添加到结果数组
                results.push({
                    fileName: fileName,
                    src: `/file/${fileId}.${fileExtension}`,
                    success: true
                });
            } catch (error) {
                errors.push({
                    fileName: file.name,
                    error: error.message,
                    success: false
                });
            }
        });

        // 等待所有上传完成
        await Promise.all(uploadPromises);

        // 返回结果
        return new Response(
            JSON.stringify({
                success: errors.length === 0,
                results: results,
                errors: errors,
                total: files.length,
                successful: results.length,
                failed: errors.length
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Batch upload error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

function getFileId(response) {
    if (!response.ok || !response.result) return null;

    const result = response.result;
    if (result.photo) {
        return result.photo.reduce((prev, current) =>
            (prev.file_size > current.file_size) ? prev : current
        ).file_id;
    }
    if (result.document) return result.document.file_id;
    if (result.video) return result.video.file_id;
    if (result.audio) return result.audio.file_id;

    return null;
}

async function sendToTelegram(formData, apiEndpoint, env, retryCount = 0) {
    const MAX_RETRIES = 2;
    const apiUrl = `https://api.telegram.org/bot${env.TG_Bot_Token}/${apiEndpoint}`;
    try {
        const response = await fetch(apiUrl, { method: "POST", body: formData });
        const responseData = await response.json();

        if (response.ok) {
            return { success: true, data: responseData };
        }

        // 图片上传失败时转为文档方式重试
        if (retryCount < MAX_RETRIES && apiEndpoint === 'sendPhoto') {
            console.log('Retrying image as document...');
            const newFormData = new FormData();
            newFormData.append('chat_id', formData.get('chat_id'));
            newFormData.append('document', formData.get('photo'));
            return await sendToTelegram(newFormData, 'sendDocument', env, retryCount + 1);
        }

        return {
            success: false,
            error: responseData.description || 'Upload to Telegram failed'
        };
    } catch (error) {
        console.error('Network error:', error);
        if (retryCount < MAX_RETRIES) {
            await new Promise(resolve => setTimeout(resolve, 1000 * (retryCount + 1)));
            return await sendToTelegram(formData, apiEndpoint, env, retryCount + 1);
        }
        return { success: false, error: 'Network error occurred' };
    }
}
