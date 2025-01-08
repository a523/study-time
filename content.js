// 存储 observer 实例以便需要时断开连接
let observer = null;
let isInitialized = false;
let retryCount = 0;
const MAX_RETRIES = 3;

// 添加缓存对象
const titleCache = new Map();
const CACHE_DURATION = 24 * 60 * 60 * 1000; // 24小时缓存

// 添加配置常量
const CONFIG = {
  BATCH_SIZE: 30,                    // 每批处理的标题数量
  CACHE_DURATION: 24 * 60 * 60 * 1000, // 缓存时长（24小时）
  MAX_RETRIES: 3,                    // 最大重试次数
  RETRY_DELAY: 1000,                // 初始重试延迟（毫秒）
  MAX_TITLE_LENGTH: 200,           // 标题最大长度
  DEFAULT_TEMPERATURE: 0,          // AI 温度参数（0表示最确定的输出）
  MAX_TOKENS: 100,                 // 最大 token 数
  RESPONSE_TIMEOUT: 60000,         // 响应超时时间（60秒）
  RETRY_BACKOFF_FACTOR: 1.5        // 重试延迟增长因子
};

// 初始化 AI 客户端
let aiClient = null;

// 从存储中获取设置并初始化客户端
async function initializeAIClient() {
  try {
    const settings = await chrome.storage.sync.get([
      'modelType',
      'azureEndpoint',
      'azureApiKey',
      'azureDeploymentId',
      'doubaiEndpoint',
      'doubaiApiKey',
      'doubaiModel'
    ]);

    // 检查是否有有效的设置
    if (!settings.modelType) {
      console.warn('未选择 AI 模型类型');
      return null;
    }

    if (settings.modelType === 'azure') {
      if (!settings.azureEndpoint || !settings.azureApiKey || !settings.azureDeploymentId) {
        console.warn('Azure OpenAI 设置不完整');
        return null;
      }
      aiClient = AIClientFactory.createClient('azure', {
        endpoint: settings.azureEndpoint,
        apiKey: settings.azureApiKey,
        deploymentId: settings.azureDeploymentId
      });
    } else if (settings.modelType === 'doubai') {
      if (!settings.doubaiEndpoint || !settings.doubaiApiKey || !settings.doubaiModel) {
        console.warn('豆包大模型设置不完整');
        return null;
      }
      aiClient = AIClientFactory.createClient('doubai', {
        endpoint: settings.doubaiEndpoint,
        apiKey: settings.doubaiApiKey,
        model: settings.doubaiModel
      });
    } else {
      console.warn('不支持的 AI 模型类型:', settings.modelType);
      return null;
    }

    return aiClient;
  } catch (error) {
    console.error('初始化 AI 客户端时出错:', error);
    return null;
  }
}

// 监听存储变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && (
    changes.modelType ||
    changes.azureEndpoint ||
    changes.azureApiKey ||
    changes.azureDeploymentId ||
    changes.doubaiEndpoint ||
    changes.doubaiApiKey ||
    changes.doubaiModel
  )) {
    initializeAIClient();
  }
});

// 在页面加载时初始化客户端
initializeAIClient();

// 使用 AI 客户端处理内容
async function processContent(content) {
  if (!aiClient) {
    console.warn('AI 客户端未初始化，跳过内容处理');
    return null;
  }

  try {
    const response = await aiClient.getChatCompletions([
      {
        role: "system",
        content: "你是一个专注于学习内容优化的 AI 助手。请帮助分析和优化用户提供的学习内容。"
      },
      {
        role: "user",
        content: content
      }
    ]);

    return response;
  } catch (error) {
    console.error('处理内容时出错:', error);
    return null;
  }
}

// 添加连接状态检查函数
async function waitForExtensionReady(maxAttempts = 5, interval = 1000) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      if (chrome.runtime?.id) {
        // 尝试进行一个简单的存储操作来验证连接
        await chrome.storage.local.get('test');
        return true;
      }
    } catch (error) {
      console.warn(`Attempt ${i + 1}: Extension not ready yet`);
    }
    await new Promise(resolve => setTimeout(resolve, interval));
  }
  return false;
}

// 初始化布局
function initializeLayout() {
  const containers = document.querySelectorAll('.bili-grid, .feed-card');
  containers.forEach(container => {
    if (!container.classList.contains('bili-grid') && !container.classList.contains('feed-card')) {
      container.classList.add('bili-grid');
    }
  });
}

// 初始化函数
async function initialize() {
  if (isInitialized) return;
  
  try {
    const isReady = await waitForExtensionReady();
    if (!isReady) {
      throw new Error('Extension failed to initialize after multiple attempts');
    }

    if (!chrome.runtime?.id) {
      console.log('Extension context invalid, waiting for reconnection...');
      setTimeout(() => {
        retryCount = 0;
        initialize();
      }, 2000);
      return;
    }

    // 添加样式
    const style = document.createElement('style');
    style.textContent = `
      .bili-video-card {
        position: relative !important;
      }
      
      .study-filter-analyzing-wrapper {
        position: fixed;
        bottom: 20px;
        right: 20px;
        transform: none;
        z-index: 99999;
        pointer-events: none;
        background-color: rgba(0, 0, 0, 0.7);
        color: white;
        padding: 8px 16px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: bold;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.3s ease;
      }

      .study-filter-analyzing-wrapper.show {
        opacity: 1;
      }
      
      .study-filter-hidden {
        display: none !important;
      }

      /* 保持网格布局的样式 */
      .bili-grid {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) !important;
        grid-gap: 20px !important;
        padding: 0 20px !important;
      }

      /* 保持瀑布流布局的样式 */
      .feed-card {
        display: grid !important;
        grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)) !important;
        grid-gap: 20px !important;
      }
    `;
    document.head.appendChild(style);

    await loadCache();
    cleanup();
    initializeLayout();

    const { filterEnabled } = await chrome.storage.sync.get('filterEnabled');
    if (filterEnabled === undefined) {
      await chrome.storage.sync.set({ filterEnabled: true });
    }

    observer = new MutationObserver(debounce(handleMutation, 500));
    observer.observe(document.body, {
      childList: true,
      subtree: true
    });

    await processCurrentVideos();
    
    isInitialized = true;
    retryCount = 0;
    
  } catch (error) {
    console.error('Error during initialization:', error);
    if (error.message.includes('Extension context invalidated')) {
      setTimeout(() => {
        retryCount = 0;
        initialize();
      }, 2000);
    } else {
      await handleInitError();
    }
  }
}

// 处理初始化错误
async function handleInitError() {
  cleanup();
  if (retryCount < MAX_RETRIES) {
    retryCount++;
    console.log(`Retrying initialization (${retryCount}/${MAX_RETRIES})...`);
    // 增加重试间隔时间
    await new Promise(resolve => setTimeout(resolve, 2000 * retryCount));
    await initialize();
  } else {
    console.error('Max retry attempts reached');
    // 添加自动重新加载逻辑
    setTimeout(() => {
      retryCount = 0;
      initialize();
    }, 5000);
  }
}

// 添加处理状态追踪
let isProcessing = false;
let processingTimeout = null;

// 防抖函数
const debouncedProcessing = debounce(async () => {
  if (isProcessing) return;
  
  try {
    isProcessing = true;
    await processCurrentVideos();
  } finally {
    isProcessing = false;
  }
}, 1000);

// 处理 DOM 变化
async function handleMutation(mutations) {
  try {
    if (!chrome.runtime?.id) {
      throw new Error('Extension context invalidated');
    }

    const { filterEnabled } = await chrome.storage.sync.get('filterEnabled');
    if (!filterEnabled) return;

    if (isProcessing) {
      return;
    }

    debouncedProcessing();
  } catch (error) {
    console.error('Error in mutation observer:', error);
    if (error.message.includes('Extension context invalidated')) {
      cleanup();
      setTimeout(() => {
        retryCount = 0;
        initialize();
      }, 1000);
    }
  }
}

// 清理函数
function cleanup() {
  if (observer) {
    try {
      observer.disconnect();
    } catch (error) {
      console.error('Error disconnecting observer:', error);
    }
    observer = null;
  }
  
  // 清理定时器和状态
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  isProcessing = false;
  isInitialized = false;
}

// 防抖函数实现
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// 处理当前页面上的视频
async function processCurrentVideos() {
  try {
    const selectors = ['.bili-video-card'];
    let hasUnprocessedCards = false;
    let analysisWrapper = document.querySelector('.study-filter-analyzing-wrapper');

    // 创建或更新分析提示符
    if (!analysisWrapper) {
      analysisWrapper = document.createElement('div');
      analysisWrapper.className = 'study-filter-analyzing-wrapper';
      analysisWrapper.textContent = '分析中...';
      document.body.appendChild(analysisWrapper);
    }

    for (const selector of selectors) {
      try {
        const videoCards = document.querySelectorAll(selector);
        const cardsToProcess = Array.from(videoCards).filter(card => !card.dataset.processed);
        
        if (cardsToProcess.length === 0) continue;
        
        hasUnprocessedCards = true;
        // 显示分析提示符
        analysisWrapper.classList.add('show');

        // 为所有未处理的卡片添加临时模糊效果
        cardsToProcess.forEach(card => {
          try {
            applyFilterEffect(card, true);
          } catch (error) {
            console.warn('Error adding temp blur:', error);
          }
        });

        // 收集所有标题并处理
        const cardTitles = await Promise.all(
          cardsToProcess.map(async card => ({
            card,
            title: await findVideoTitle(card)
          }))
        );

        const validCardTitles = cardTitles.filter(item => item.title);
        if (validCardTitles.length === 0) continue;

        // 分批处理
        const batches = [];
        for (let i = 0; i < validCardTitles.length; i += CONFIG.BATCH_SIZE) {
          batches.push(validCardTitles.slice(i, i + CONFIG.BATCH_SIZE));
        }

        // 处理每一批
        for (const batch of batches) {
          try {
            const results = await checkMultipleContents(batch.map(item => item.title));
            batch.forEach(({ card, title }, index) => {
              try {
                card.dataset.tempBlur = 'false';
                if (!results[index]) {
                  applyFilterEffect(card, false);
                }
                card.dataset.processed = 'true';
              } catch (error) {
                console.warn('Error applying result to card:', error);
              }
            });
          } catch (error) {
            console.error('Error processing batch:', error);
            batch.forEach(({ card }) => {
              card.dataset.processed = 'true';
            });
          }
        }
      } catch (error) {
        console.error('Error processing selector:', error);
      }
    }

    // 如果所有卡片都处理完成，隐藏并移除分析提示符
    if (!hasUnprocessedCards && analysisWrapper) {
      analysisWrapper.classList.remove('show');
      // 等待过渡动画完成后移除元素
      setTimeout(() => {
        if (analysisWrapper && analysisWrapper.parentNode) {
          analysisWrapper.parentNode.removeChild(analysisWrapper);
        }
      }, 300);
    }
  } catch (error) {
    console.error('Error in processCurrentVideos:', error);
    // 确保在发生错误时也移除提示符
    const analysisWrapper = document.querySelector('.study-filter-analyzing-wrapper');
    if (analysisWrapper) {
      analysisWrapper.classList.remove('show');
      setTimeout(() => {
        if (analysisWrapper && analysisWrapper.parentNode) {
          analysisWrapper.parentNode.removeChild(analysisWrapper);
        }
      }, 300);
    }
  }
}

// 处理 API 响应
async function processApiResponse(response, titlesToCheck) {
  const answer = response.choices[0].message?.content?.trim();
  if (!answer) {
    throw new Error('Empty response from API');
  }

  console.log('处理 API 响应:', {
    answer,
    titlesToCheck,
    titlesToCheckLength: titlesToCheck.length
  });

  const answers = answer.split(',').map(r => r.trim().toLowerCase());

  if (answers.length !== titlesToCheck.length) {
    console.error('响应数量不匹配:', {
      expected: titlesToCheck.length,
      got: answers.length,
      answers,
      titles: titlesToCheck
    });
    throw new Error(`Response count mismatch: expected ${titlesToCheck.length}, got ${answers.length}. Response: ${answer}`);
  }

  const invalidAnswers = answers.filter(a => a !== '是' && a !== '否' && a !== 'yes' && a !== 'no');
  if (invalidAnswers.length > 0) {
    throw new Error(`Invalid answers found: ${invalidAnswers.join(', ')}`);
  }

  return answers.map(r => r === '是' || r === 'yes');
}

// 构建 AI 请求消息
function buildAiMessages(topic, titlesToCheck) {
  const numberedTitles = titlesToCheck
    .map((title, index) => `${index + 1}. ${title}`)
    .join('\n');

  return [
    {
      role: "system",
      content: `你是一个教育内容分析助手。你的任务是严格按照以下规则分析视频标题：

               分析规则：
               1. 判断标题是否与以下主题相关：【${topic}】
               2. 只要标题与其中任何一个主题相关，就回答"是"
               3. 如果与所有主题都无关，则回答"否"
               4. 答案必须用逗号分隔，且必须是"是"或"否"
               5. 必须且只能回答${titlesToCheck.length}个答案，不能多也不能少
               6. 仅输出答案，不要有任何解释或额外内容
               7. 答案必须与输入标题一一对应
               
               错误示例：
               - 输出超过${titlesToCheck.length}个答案
               - 输出少于${titlesToCheck.length}个答案
               - 包含额外的解释文字
               - 使用"是"和"否"以外的词

               正确示例（假设输入3个标题）：
               是,否,是

               请记住：你的输出必须且只能包含${titlesToCheck.length}个由逗号分隔的"是"或"否"。`
    },
    {
      role: "user",
      content: `请严格分析以下${titlesToCheck.length}个标题是否与这些主题相关：【${topic}】\n${numberedTitles}\n\n请记住：只需输出${titlesToCheck.length}个答案，用逗号分隔。`
    }
  ];
}

// 主函数
async function checkMultipleContents(titles) {
  try {
    if (!aiClient) {
      return titles.map(() => true);
    }

    const validTitles = titles.map(title => 
      typeof title === 'string' ? title.slice(0, CONFIG.MAX_TITLE_LENGTH) : ''
    ).filter(Boolean);

    if (validTitles.length === 0) {
      return titles.map(() => true);
    }

    const results = validTitles.map(title => ({
      title,
      ...titleCache.get(title) && (Date.now() - titleCache.get(title).timestamp < CONFIG.CACHE_DURATION)
        ? { result: titleCache.get(title).isLearning, fromCache: true }
        : { fromCache: false }
    }));

    const titlesToCheck = results.filter(item => !item.fromCache).map(item => item.title);

    if (titlesToCheck.length === 0) {
      return results.map(item => item.result);
    }

    const settings = await chrome.storage.sync.get(['selectedTopics', 'customTopics']);
    let topics = [];
    if (settings.selectedTopics?.includes('all')) {
      const topicMap = {
        'programming': '编程',
        'language': '语言学习',
        'academic': '学术',
        'technology': '科技',
        'science': '科学',
        'math': '数学'
      };
      topics.push(...Object.values(topicMap));
      if (settings.customTopics?.length > 0) {
        topics.push(...settings.customTopics.filter(Boolean));
      }
    } else {
      const topicMap = {
        'programming': '编程',
        'language': '语言学习',
        'academic': '学术',
        'technology': '科技',
        'science': '科学',
        'math': '数学'
      };
      topics.push(...(settings.selectedTopics || [])
        .filter(topic => topic !== 'custom' && topic !== 'all')
        .map(topic => topicMap[topic])
        .filter(Boolean));
      if (settings.selectedTopics?.includes('custom') && settings.customTopics?.length > 0) {
        topics.push(...settings.customTopics.filter(Boolean));
      }
    }

    if (topics.length === 0) {
      topics = ['学习'];
    }

    const topic = topics.join('、');
    const messages = buildAiMessages(topic, titlesToCheck);
    const apiResults = await retryWithTimeout(async () => {
      const response = await aiClient.getChatCompletions(messages, {
        maxTokens: Math.max(CONFIG.MAX_TOKENS, titlesToCheck.length * 5),
        temperature: 0
      });
      const ans = await processApiResponse(response, titlesToCheck);
      return ans;
    });

    titlesToCheck.forEach((title, index) => {
      titleCache.set(title, { isLearning: apiResults[index], timestamp: Date.now() });
    });

    let resultIndex = 0;
    return results.map(item => item.fromCache ? item.result : apiResults[resultIndex++]);

  } catch (error) {
    console.error('检查多个内容时出错:', error);
    return titles.map(() => true);
  }
}

// 重试函数
async function retryWithTimeout(operation) {
  let retryCount = 0;
  let delay = CONFIG.RETRY_DELAY;

  while (retryCount < CONFIG.MAX_RETRIES) {
    try {
      return await Promise.race([
        operation(),
        new Promise((_, reject) => 
          setTimeout(() => reject(new Error('Request timeout')), CONFIG.RESPONSE_TIMEOUT)
        )
      ]);
    } catch (error) {
      retryCount++;
      console.warn(`Attempt ${retryCount} failed:`, error);
      
      if (error.message.includes('call rate limit')) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay *= CONFIG.RETRY_BACKOFF_FACTOR; // 指数退避
        continue;
      }
      
      if (retryCount >= CONFIG.MAX_RETRIES) {
        throw error;
      }
      
      await new Promise(resolve => setTimeout(resolve, delay));
      delay *= CONFIG.RETRY_BACKOFF_FACTOR; // 指数退避
    }
  }
}

// 查找视频标题
async function findVideoTitle(card) {
  try {
    const titleSelectors = [
      // 新版 B 站首页视频卡片标题
      '.bili-video-card__info--tit',
      // 视频标题链接
      '.bili-video-card__info--tit a',
      // 标题属性
      '[title]',
    ];
    
    for (const titleSelector of titleSelectors) {
      try {
        const titleElement = card.querySelector(titleSelector);
        if (titleElement) {
          // 优先使用 title 属性，因为它包含完整标题
          const title = titleElement.getAttribute('title') || titleElement.textContent;
          if (title) {
            return title.trim();
          }
        }
      } catch (error) {
        console.warn(`Error finding title with selector ${titleSelector}:`, error);
        continue;
      }
    }
    
    return null;
  } catch (error) {
    console.error('Error in findVideoTitle:', error);
    return null;
  }
}

// 应用模糊效果的统一函数
async function applyFilterEffect(card, isTemporary = false) {
  const settings = await chrome.storage.sync.get(['filterMode']);
  const filterMode = settings.filterMode || 'hide'; // 默认为隐藏模式

  if (filterMode === 'hide') {
    if (!isTemporary) {
      card.classList.add('study-filter-hidden');
    }
    return;
  }

  // 以下是模糊模式的逻辑
  const blurWrapper = document.createElement('div');
  blurWrapper.className = 'study-filter-blur-wrapper';
  blurWrapper.style.position = 'absolute';
  blurWrapper.style.top = '0';
  blurWrapper.style.left = '0';
  blurWrapper.style.width = '100%';
  blurWrapper.style.height = '100%';
  blurWrapper.style.backdropFilter = 'blur(10px)';
  blurWrapper.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
  blurWrapper.style.zIndex = '1';
  blurWrapper.style.cursor = 'pointer';
  blurWrapper.style.display = 'flex';
  blurWrapper.style.justifyContent = 'center';
  blurWrapper.style.alignItems = 'center';
  blurWrapper.style.transition = 'opacity 0.3s ease';

  const text = document.createElement('div');
  text.textContent = '不相关的视频已模糊处理';
  text.style.color = '#fff';
  text.style.textShadow = '0 0 4px rgba(0, 0, 0, 0.5)';
  text.style.padding = '8px 16px';
  text.style.borderRadius = '4px';
  text.style.backgroundColor = 'rgba(0, 0, 0, 0.6)';
  text.style.fontSize = '14px';
  text.style.fontWeight = 'bold';
  text.style.pointerEvents = 'none';

  blurWrapper.appendChild(text);
  card.style.position = 'relative';
  card.appendChild(blurWrapper);

  if (!isTemporary) {
    const cleanup = () => {
      card.removeChild(blurWrapper);
      card.removeEventListener('mouseleave', handleMouseLeave);
      card.removeEventListener('mouseenter', handleMouseEnter);
    };

    const handleMouseEnter = (e) => {
      if (e.target === card || card.contains(e.target)) {
        blurWrapper.style.opacity = '0';
        blurWrapper.style.pointerEvents = 'none';
      }
    };

    const handleMouseLeave = (e) => {
      if (!card.contains(e.relatedTarget)) {
        blurWrapper.style.opacity = '1';
        blurWrapper.style.pointerEvents = 'auto';
      }
    };

    card.addEventListener('mouseenter', handleMouseEnter);
    card.addEventListener('mouseleave', handleMouseLeave);

    return cleanup;
  }
}

// 监听来自 background script 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  try {
    if (message.type === 'PAGE_LOADED') {
      // 立即发送响应
      sendResponse({ received: true });
      // 然后执行初始化
      retryCount = 0;
      cleanup();
      initialize();
    }
  } catch (error) {
    console.error('Error handling message:', error);
  }
});

// 监听存储变化
chrome.storage.onChanged.addListener((changes, namespace) => {
  try {
    if (namespace === 'sync' && changes.filterEnabled) {
      if (changes.filterEnabled.newValue) {
        retryCount = 0;
        initialize();
      } else {
        cleanup();
      }
    }
  } catch (error) {
    console.error('Error handling storage change:', error);
  }
});

// 检查扩展上下文是否有效的函数
function isExtensionContextValid() {
  return Boolean(chrome.runtime?.id);
}

// 页面加载完成后初始化
if (document.readyState === 'complete') {
  if (isExtensionContextValid()) {
    initialize();
  }
} else {
  window.addEventListener('load', () => {
    if (isExtensionContextValid()) {
      initialize();
    }
  });
}

// 页面卸载时清理
window.addEventListener('unload', cleanup);

// 定期检查扩展状态
setInterval(() => {
  if (!isInitialized && isExtensionContextValid()) {
    retryCount = 0;
    initialize();
  }
}, 5000);

// 在页面卸载时保存缓存到 storage
window.addEventListener('beforeunload', () => {
  const cacheData = Array.from(titleCache.entries()).map(([title, data]) => ({
    title,
    isLearning: data.isLearning,
    timestamp: data.timestamp
  }));
  
  chrome.storage.local.set({ titleCache: cacheData });
});

// 在初始化时加载缓存
async function loadCache() {
  try {
    if (!chrome.runtime?.id) {
      throw new Error('Extension context invalidated');
    }
    const data = await chrome.storage.local.get('titleCache');
    if (data.titleCache) {
      data.titleCache.forEach(item => {
        titleCache.set(item.title, {
          isLearning: item.isLearning,
          timestamp: item.timestamp
        });
      });
    }
  } catch (error) {
    console.warn('Failed to load cache:', error);
    // 不抛出错误，让程序继续运行
  }
}

// 添加错误处理函数
function handleError(error) {
  if (error.message.includes('Extension context invalidated')) {
    cleanup();
    // 等待扩展重新加载
    setTimeout(() => {
      retryCount = 0;
      initialize();
    }, 2000);
    return true;
  }
  return false;
}

// 修改所有使用 chrome.runtime 的地方，添加错误处理
try {
  // chrome.runtime 相关操作
} catch (error) {
  if (!handleError(error)) {
    console.error('Unhandled error:', error);
  }
} 