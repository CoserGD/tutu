import { errorHandling, telemetryData } from "../../utils/middleware";

// 获取所有链接
export async function onRequestGet(context) {
    const { env, request } = context;
    
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

        // 获取查询参数
        const url = new URL(request.url);
        const category = url.searchParams.get('category') || 'all';
        const page = parseInt(url.searchParams.get('page') || '1');
        const limit = parseInt(url.searchParams.get('limit') || '50');
        const search = url.searchParams.get('search') || '';

        // 列出所有键
        const listResult = await env.img_url.list();
        let keys = listResult.keys;

        // 根据分类筛选
        if (category !== 'all') {
            keys = keys.filter(key => {
                const metadata = key.metadata;
                if (category === 'liked' && metadata.liked) return true;
                if (category === 'batch' && metadata.batchUpload) return true;
                if (category === 'white' && metadata.ListType === 'White') return true;
                if (category === 'block' && metadata.ListType === 'Block') return true;
                return false;
            });
        }

        // 根据搜索词筛选
        if (search) {
            keys = keys.filter(key => {
                const fileName = key.metadata.fileName || '';
                return fileName.toLowerCase().includes(search.toLowerCase());
            });
        }

        // 计算分页
        const total = keys.length;
        const totalPages = Math.ceil(total / limit);
        const startIndex = (page - 1) * limit;
        const endIndex = startIndex + limit;
        const paginatedKeys = keys.slice(startIndex, endIndex);

        // 构建结果
        const items = paginatedKeys.map(key => {
            const fileId = key.name;
            const metadata = key.metadata;
            return {
                id: fileId,
                fileName: metadata.fileName || 'Unknown',
                fileSize: metadata.fileSize || 0,
                timeStamp: metadata.TimeStamp || 0,
                listType: metadata.ListType || 'None',
                liked: metadata.liked || false,
                batchUpload: metadata.batchUpload || false,
                url: `/file/${fileId}`
            };
        });

        return new Response(
            JSON.stringify({
                success: true,
                items: items,
                pagination: {
                    total,
                    page,
                    limit,
                    totalPages
                }
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Link management error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}

// 批量操作链接（删除、标记喜欢、添加到白名单/黑名单等）
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
        const data = await request.json();
        const { action, ids } = data;
        
        if (!action || !ids || !Array.isArray(ids) || ids.length === 0) {
            return new Response(
                JSON.stringify({ error: "Invalid request parameters" }),
                {
                    status: 400,
                    headers: { 'Content-Type': 'application/json' }
                }
            );
        }

        const results = [];
        const errors = [];

        // 并行处理所有操作
        const operationPromises = ids.map(async (id) => {
            try {
                // 获取当前元数据
                const value = await env.img_url.get(id, { type: "text", metadata: true });
                if (value === null) {
                    throw new Error(`Item with ID ${id} not found`);
                }
                
                const metadata = value.metadata || {};
                let newMetadata = { ...metadata };

                // 根据操作类型更新元数据
                switch (action) {
                    case 'delete':
                        await env.img_url.delete(id);
                        results.push({ id, action, success: true });
                        return;
                    case 'like':
                        newMetadata.liked = true;
                        break;
                    case 'unlike':
                        newMetadata.liked = false;
                        break;
                    case 'whitelist':
                        newMetadata.ListType = 'White';
                        break;
                    case 'blacklist':
                        newMetadata.ListType = 'Block';
                        break;
                    case 'resetlist':
                        newMetadata.ListType = 'None';
                        break;
                    default:
                        throw new Error(`Unknown action: ${action}`);
                }

                // 更新KV存储
                await env.img_url.put(id, "", { metadata: newMetadata });
                results.push({ id, action, success: true });
            } catch (error) {
                errors.push({ id, action, error: error.message, success: false });
            }
        });

        // 等待所有操作完成
        await Promise.all(operationPromises);

        // 返回结果
        return new Response(
            JSON.stringify({
                success: errors.length === 0,
                results,
                errors,
                total: ids.length,
                successful: results.length,
                failed: errors.length
            }),
            {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    } catch (error) {
        console.error('Batch operation error:', error);
        return new Response(
            JSON.stringify({ error: error.message }),
            {
                status: 500,
                headers: { 'Content-Type': 'application/json' }
            }
        );
    }
}
