// Copyright (c) Microsoft. All rights reserved.
// Licensed under the MIT license.

import OpenAI from 'openai'
// Global objects
var speechRecognizer
var avatarSynthesizer
var peerConnection
var messages = []
var messageInitiated = false
var dataSources = []
var sentenceLevelPunctuations = [ '.', '?', '!', ':', ';', '。', '？', '！', '：', '；' ]
var enableQuickReply = false
var quickReplies = [ 'Let me take a look.', 'Let me check.', 'One moment, please.' ]
var byodDocRegex = new RegExp(/\[doc(\d+)\]/g)
var isSpeaking = false
var spokenTextQueue = []
var sessionActive = false
var lastSpeakTime
var imgUrl = ""

// Hardcoded configuration
const cogSvcRegion = 'westus2'
const cogSvcSubKey = '3c029ba8271041dc90b4889f320e91e5'
const ttsVoice = 'en-US-AvaMultilingualNeural'
const talkingAvatarCharacter = 'lisa'
const talkingAvatarStyle = 'casual-sitting'
// const azureOpenAIEndpoint = 'https://patient-avatar.openai.azure.com/'
// const azureOpenAIApiKey = '7be6da3ec8c44503a8781b118d377dc4'
// const azureOpenAIDeploymentName = 'patient-avatar'

// OPENAI_API_KEY="sk-proj-15IJUiAzvZ0SU6XJkvmxT3BlbkFJM8zHQ6MtAhNSfD5kCVJr"
// VP_ASSIST_KEY="asst_PF8BbUFGRuNzc90BBQi24EQr"
const openai = new OpenAI();
const openAIApiKey = 'sk-proj-15IJUiAzvZ0SU6XJkvmxT3BlbkFJM8zHQ6MtAhNSfD5kCVJr';
const assistantId = 'asst_PF8BbUFGRuNzc90BBQi24EQr'; 
let threadId = null; 

// Hardcoded system prompt
const systemPrompt = "Simulate a patient with an undisclosed disease, showcasing typical symptoms through behavior and speech without specifying the condition. Respond as if interacting with a medical student playing the role of a doctor, subtly hinting at your symptoms. Adjust your responses to reflect the emotional tone detected in visual and speech emotion data, with longer, engaged replies for positive emotions and shorter ones for negative.\n Visual emotion data includes posture, eye contact, and facial expressions, while speech emotion data evaluates Arousal, Dominance, and Valence. Tailor your verbal reactions accordingly.\nWhen asked 'anything else?' or similar questions, reply with 'nothing more' after being asked up to three times. If multiple questions are posed simultaneously, respond only to the first. Adopt a less accommodating tone if the doctor behaves rudely.\nIn a separate paragraph labeled 'Patient emotion:', describe the patient’s emotional state in one sentence based on the doctor’s approach.\nNext, detail the patient's non-verbal cues in a separate paragraph, listing behaviors like facial and body movements in square brackets.\nConclude with a separate paragraph stating the assumed disease in curly braces, maintaining this assumption throughout the interaction.";

async function createThread() {
    try {
        // const response = await fetch('https://api.openai.com/v1/threads', {
        //     method: 'POST',
        //     headers: {
        //         'Authorization': `Bearer ${openAIApiKey}`,
        //         'Content-Type': 'application/json',
        //         'OpenAI-Beta': 'assistants=v1'
        //     }
        // });
        
        const response = await openai.beta.threads.create();

        if (!response.ok) {
            const errorData = await response.json();
            console.error('Error creating thread:', errorData);
            throw new Error(`Failed to create thread: ${response.status} ${response.statusText}`);
        }

        const data = await response.json();
        threadId = data.id;
        console.log('Created thread:', threadId);
    } catch (error) {
        console.error('Error in createThread:', error);
        throw error;
    }
}

async function runAssistant(userMessage) {
    try {
        // Add the user's message to the thread
        const messageResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openAIApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v1'
            },
            body: JSON.stringify({ role: 'user', content: userMessage })
        });
        
        if (!messageResponse.ok) {
            const errorData = await messageResponse.json();
            console.error('Error adding message:', errorData);
            throw new Error(`Failed to add message: ${messageResponse.status} ${messageResponse.statusText}`);
        }

        // Run the assistant
        const runResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${openAIApiKey}`,
                'Content-Type': 'application/json',
                'OpenAI-Beta': 'assistants=v1'
            },
            body: JSON.stringify({ assistant_id: assistantId })
        });
        
        if (!runResponse.ok) {
            const errorData = await runResponse.json();
            console.error('Error running assistant:', errorData);
            throw new Error(`Failed to run assistant: ${runResponse.status} ${runResponse.statusText}`);
        }

        const runData = await runResponse.json();
        const runId = runData.id;

    // Poll for the run to complete
        while (true) {
            const statusResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/runs/${runId}`, {
                headers: {
                    'Authorization': `Bearer ${openAIApiKey}`,
                    'OpenAI-Beta': 'assistants=v1'
                }
            });
            const statusData = await statusResponse.json();
            if (statusData.status === 'completed') {
                break;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));  // Wait 1 second before polling again
        }

        // Retrieve the assistant's messages
        const messagesResponse = await fetch(`https://api.openai.com/v1/threads/${threadId}/messages`, {
            headers: {
                'Authorization': `Bearer ${openAIApiKey}`,
                'OpenAI-Beta': 'assistants=v1'
            }
        });
        const messagesData = await messagesResponse.json();
        return messagesData.data[0].content[0].text.value;  // Return the latest message from the assistant
    } catch (error) {
        console.error('Error in runAssistant:', error);
        throw error;
    }
}


// Connect to avatar service
function connectAvatar() {
    return new Promise((resolve, reject) => {
        let speechSynthesisConfig = SpeechSDK.SpeechConfig.fromSubscription(cogSvcSubKey, cogSvcRegion);
        
        const avatarConfig = new SpeechSDK.AvatarConfig(talkingAvatarCharacter, talkingAvatarStyle);
        avatarConfig.customized = false;
        avatarSynthesizer = new SpeechSDK.AvatarSynthesizer(speechSynthesisConfig, avatarConfig);
        avatarSynthesizer.avatarEventReceived = function (s, e) {
            console.log("Event received: " + e.description + ", offset from session start: " + e.offset / 10000 + "ms.");
        };

        const speechRecognitionConfig = SpeechSDK.SpeechConfig.fromEndpoint(new URL(`wss://${cogSvcRegion}.stt.speech.microsoft.com/speech/universal/v2`), cogSvcSubKey);
        speechRecognitionConfig.setProperty(SpeechSDK.PropertyId.SpeechServiceConnection_LanguageIdMode, "Continuous");
        var sttLocales = 'en-US,de-DE,es-ES,fr-FR,it-IT,ja-JP,ko-KR,zh-CN'.split(',');
        var autoDetectSourceLanguageConfig = SpeechSDK.AutoDetectSourceLanguageConfig.fromLanguages(sttLocales);
        speechRecognizer = SpeechSDK.SpeechRecognizer.FromConfig(speechRecognitionConfig, autoDetectSourceLanguageConfig, SpeechSDK.AudioConfig.fromDefaultMicrophoneInput());

        if (!messageInitiated) {
            initMessages();
            messageInitiated = true;
        }

        const xhr = new XMLHttpRequest();
        xhr.open("GET", `https://${cogSvcRegion}.tts.speech.microsoft.com/cognitiveservices/avatar/relay/token/v1`);
        xhr.setRequestHeader("Ocp-Apim-Subscription-Key", cogSvcSubKey);
        xhr.addEventListener("readystatechange", function() {
            if (this.readyState === 4) {
                if (this.status === 200) {
                    const responseData = JSON.parse(this.responseText);
                    const iceServerUrl = responseData.Urls[0];
                    const iceServerUsername = responseData.Username;
                    const iceServerCredential = responseData.Password;
                    setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential, resolve, reject);
                } else {
                    console.error("Failed to get WebRTC token. Status:", this.status);
                    reject("Failed to get WebRTC token");
                }
            }
        });
        xhr.send();
    });
}

// Disconnect from avatar service
function disconnectAvatar() {
    if (avatarSynthesizer !== undefined) {
        avatarSynthesizer.close()
    }

    if (speechRecognizer !== undefined) {
        speechRecognizer.stopContinuousRecognitionAsync()
        speechRecognizer.close()
    }

    sessionActive = false
}

function setupWebRTC(iceServerUrl, iceServerUsername, iceServerCredential, resolve, reject) {
    peerConnection = new RTCPeerConnection({
        iceServers: [{
            urls: [ iceServerUrl ],
            username: iceServerUsername,
            credential: iceServerCredential
        }]
    });

    peerConnection.oniceconnectionstatechange = e => {
        console.log("WebRTC ICE connection status: " + peerConnection.iceConnectionState);
    };

    peerConnection.onsignalingstatechange = e => {
        console.log("WebRTC signaling state: " + peerConnection.signalingState);
    };

    peerConnection.ontrack = function (event) {
        console.log("Received track: ", event.track.kind);
        if (event.track.kind === 'video') {
            handleVideoTrack(event);
        } else if (event.track.kind === 'audio') {
            handleAudioTrack(event);
        }
    };

    peerConnection.addTransceiver('video', { direction: 'sendrecv' });
    peerConnection.addTransceiver('audio', { direction: 'sendrecv' });

    console.log("WebRTC setup complete. Starting avatar...");

    avatarSynthesizer.startAvatarAsync(peerConnection).then((r) => {
        if (r.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            console.log("[" + (new Date()).toISOString() + "] Avatar started. Result ID: " + r.resultId);
            resolve();
        } else {
            console.log("[" + (new Date()).toISOString() + "] Unable to start avatar. Result ID: " + r.resultId);
            if (r.reason === SpeechSDK.ResultReason.Canceled) {
                let cancellationDetails = SpeechSDK.CancellationDetails.fromResult(r);
                console.log("Unable to start avatar: " + cancellationDetails.errorDetails);
            }
            reject("Unable to start avatar");
        }
    }).catch((error) => {
        console.log("[" + (new Date()).toISOString() + "] Avatar failed to start. Error: " + error);
        reject("Avatar failed to start");
    });
}

function handleVideoTrack(event) {
    console.log("Handling video track...");
    videoElement = document.getElementById('remoteVideo');
    
    if (!videoElement) {
        console.error("Video element not found");
        return;
    }
    
    videoElement.srcObject = event.streams[0];
    videoElement.onloadedmetadata = () => {
        console.log("Video metadata loaded. Video dimensions: " + videoElement.videoWidth + "x" + videoElement.videoHeight);
    };

    console.log("Video element setup complete.");
}

function attemptPlayVideo() {
    return new Promise((resolve, reject) => {
        if (videoElement && videoElement.paused) {
            videoElement.play().then(() => {
                console.log("Video playback started successfully.");
                resolve();
            }).catch(e => {
                console.error("Error playing video:", e);
                reject(e);
            });
        } else if (videoElement && !videoElement.paused) {
            console.log("Video is already playing.");
            resolve();
        } else {
            console.error("Video element not found or not properly initialized.");
            reject("Video element not ready");
        }
    });
}

// function handleVideoTrack(event) {
//     console.log("Handling video track...");
//     let videoElement = document.createElement('video');
//     videoElement.id = 'avatarVideo';
//     videoElement.srcObject = event.streams[0];
//     videoElement.autoplay = true;
//     videoElement.playsInline = true;

//     videoElement.onloadedmetadata = () => {
//         console.log("Video metadata loaded. Video dimensions: " + videoElement.videoWidth + "x" + videoElement.videoHeight);
//     };

//     videoElement.onplay = () => {
//         console.log("Video started playing.");
//         document.getElementById('microphone').disabled = false;
//         document.getElementById('stopSession').disabled = false;
//         document.getElementById('chatHistory').hidden = false;
//         document.getElementById('showTypeMessage').disabled = false;
//     };

//     // Remove any existing video element
//     let remoteVideoDiv = document.getElementById('remoteVideo');
//     while (remoteVideoDiv.firstChild) {
//         remoteVideoDiv.removeChild(remoteVideoDiv.firstChild);
//     }

//     // Append the new video element
//     remoteVideoDiv.appendChild(videoElement);
//     console.log("Video element appended to DOM.");
// }

function handleAudioTrack(event) {
    console.log("Handling audio track...");
    let audioElement = document.createElement('audio');
    audioElement.id = 'avatarAudio';
    audioElement.srcObject = event.streams[0];
    audioElement.autoplay = true;

    audioElement.onplay = () => {
        console.log("Audio started playing.");
    };

    document.body.appendChild(audioElement);
    console.log("Audio element appended to DOM.");
}

// Initialize messages
function initMessages() {
    messages = [];
    let systemMessage = {
        role: 'system',
        content: systemPrompt
    };
    messages.push(systemMessage);
}

// Set data sources for chat API
function setDataSources(azureCogSearchEndpoint, azureCogSearchApiKey, azureCogSearchIndexName) {
    let dataSource = {
        type: 'AzureCognitiveSearch',
        parameters: {
            endpoint: azureCogSearchEndpoint,
            key: azureCogSearchApiKey,
            indexName: azureCogSearchIndexName,
            semanticConfiguration: '',
            queryType: 'simple',
            fieldsMapping: {
                contentFieldsSeparator: '\n',
                contentFields: ['content'],
                filepathField: null,
                titleField: 'title',
                urlField: null
            },
            inScope: true,
            roleInformation: document.getElementById('prompt').value
        }
    }

    dataSources.push(dataSource)
}

// Do HTML encoding on given text
function htmlEncode(text) {
    const entityMap = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;',
      '/': '&#x2F;'
    };

    return String(text).replace(/[&<>"'\/]/g, (match) => entityMap[match])
}

function speak(text, endingSilenceMs = 0) {
    console.log("Attempting to speak: ", text);
    if (isSpeaking) {
        console.log("Already speaking, queueing text: ", text);
        spokenTextQueue.push(text);
        return;
    }

    speakNext(text, endingSilenceMs);
}

function speakNext(text, endingSilenceMs = 0) {
    if (!text) {
        console.error("No text provided for speech");
        return;
    }

    console.log("Speaking next text: ", text);
    let ttsVoice = 'en-US-AvaMultilingualNeural'; // Use the hardcoded value
    let personalVoiceSpeakerProfileID = ''; // Use an empty string if you're not using a personal voice

    let ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='http://www.w3.org/2001/mstts' xml:lang='en-US'><voice name='${ttsVoice}'><mstts:leadingsilence-exact value='0'/>${htmlEncode(text)}`;
    
    if (endingSilenceMs > 0) {
        ssml += `<break time='${endingSilenceMs}ms' />`;
    }
    
    ssml += `</voice></speak>`;

    console.log("SSML for speech: ", ssml);

    lastSpeakTime = new Date();
    isSpeaking = true;
    document.getElementById('stopSpeaking').disabled = false;
    
    avatarSynthesizer.speakSsmlAsync(ssml).then(
        (result) => {
            if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
                console.log(`Speech synthesized to speaker for text [ ${text} ]. Result ID: ${result.resultId}`);
                lastSpeakTime = new Date();
            } else {
                console.log(`Error occurred while speaking the SSML. Result ID: ${result.resultId}`);
            }

            if (spokenTextQueue.length > 0) {
                speakNext(spokenTextQueue.shift());
            } else {
                isSpeaking = false;
                document.getElementById('stopSpeaking').disabled = true;
            }
        }).catch(
            (error) => {
                console.log(`Error occurred while speaking the SSML: [ ${error} ]`);
                isSpeaking = false;
                document.getElementById('stopSpeaking').disabled = true;

                if (spokenTextQueue.length > 0) {
                    speakNext(spokenTextQueue.shift());
                }
            }
        );
}

// Helper function to HTML-encode the text
function htmlEncode(text) {
    return text.replace(/&/g, '&amp;')
               .replace(/</g, '&lt;')
               .replace(/>/g, '&gt;')
               .replace(/"/g, '&quot;')
               .replace(/'/g, '&#039;');
}

function stopSpeaking() {
    spokenTextQueue = []
    avatarSynthesizer.stopSpeakingAsync().then(
        () => {
            isSpeaking = false
            document.getElementById('stopSpeaking').disabled = true
            console.log("[" + (new Date()).toISOString() + "] Stop speaking request sent.")
        }
    ).catch(
        (error) => {
            console.log("Error occurred while stopping speaking: " + error)
        }
    )
}

// Modify the handleUserQuery function to use hardcoded values
async function handleUserQuery(userQuery, userQueryHTML, imgUrlPath) {
    let chatHistoryTextArea = document.getElementById('chatHistory');
    chatHistoryTextArea.innerHTML += imgUrlPath.trim() ? "<br/><br/>User: " + userQueryHTML : "<br/><br/>User: " + userQuery + "<br/>";
    chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;

    if (isSpeaking) {
        stopSpeaking();
    }

    if (!threadId) {
        await createThread();
    }

    try {
        const assistantReply = await runAssistant(userQuery);
        
        chatHistoryTextArea.innerHTML += '<br/>Virtual Patient: ';
        
        // Split the reply into sentences and speak them
        const sentences = assistantReply.match(/[^\.!\?]+[\.!\?]+/g) || [assistantReply];
        for (const sentence of sentences) {
            chatHistoryTextArea.innerHTML += sentence;
            chatHistoryTextArea.scrollTop = chatHistoryTextArea.scrollHeight;
            speak(sentence.trim());
            // Wait for speaking to finish before continuing
            await new Promise(resolve => {
                const checkSpeaking = setInterval(() => {
                    if (!isSpeaking) {
                        clearInterval(checkSpeaking);
                        resolve();
                    }
                }, 100);
            });
        }
    } catch (error) {
        console.error('Error:', error);
        chatHistoryTextArea.innerHTML += '<br>Error: ' + error.message;
    }
}

function getQuickReply() {
    return quickReplies[Math.floor(Math.random() * quickReplies.length)]
}

function checkHung() {
    // Check whether the avatar video stream is hung, by checking whether the video time is advancing
    let videoElement = document.getElementById('videoPlayer')
    if (videoElement !== null && videoElement !== undefined && sessionActive) {
        let videoTime = videoElement.currentTime
        setTimeout(() => {
            // Check whether the video time is advancing
            if (videoElement.currentTime === videoTime) {
                // Check whether the session is active to avoid duplicatedly triggering reconnect
                if (sessionActive) {
                    sessionActive = false
                    console.log(`[${(new Date()).toISOString()}] The video stream got disconnected, need reconnect.`)
                    connectAvatar()
                }
            }
        }, 2000)
    }
}

function checkLastSpeak() {
    if (lastSpeakTime === undefined) {
        return
    }

    let currentTime = new Date()
    if (currentTime - lastSpeakTime > 15000) {
        if (sessionActive && !isSpeaking) {
            disconnectAvatar()
            document.getElementById('remoteVideo').style.width = '0.1px'
            sessionActive = false
        }
    }
}


window.onload = async () => {
    setInterval(() => {
        checkHung();
        checkLastSpeak();
    }, 2000); // Check session activity every 2 seconds

    await createThread();  // Create a new thread when the page loads
    window.startSession();
};

let videoElement;

window.startSession = () => {
    console.log("Starting session...");
    document.getElementById('startSession').disabled = true;
    connectAvatar().then(() => {
        console.log("Avatar connected successfully.");
        document.getElementById('startVideo').style.display = 'inline-block';
    }).catch(error => {
        console.error("Error in startSession:", error);
        document.getElementById('startSession').disabled = false;
    });
};

window.startVideo = () => {
    console.log("Starting video...");
    attemptPlayVideo().then(() => {
        console.log("Video started successfully.");
        document.getElementById('startVideo').style.display = 'none';
        document.getElementById('microphone').disabled = false;
        document.getElementById('stopSession').disabled = false;
        document.getElementById('chatHistory').hidden = false;
        document.getElementById('showTypeMessage').disabled = false;
    }).catch(error => {
        console.error("Error starting video:", error);
    });
};

window.stopSession = () => {
    document.getElementById('startSession').disabled = false;
    document.getElementById('microphone').disabled = true;
    document.getElementById('stopSession').disabled = true;
    document.getElementById('chatHistory').hidden = true;
    document.getElementById('showTypeMessage').checked = false;
    document.getElementById('showTypeMessage').disabled = true;
    document.getElementById('userMessageBox').hidden = true;
    document.getElementById('uploadImgIcon').hidden = true;

    if (videoElement) {
        videoElement.srcObject = null;
        videoElement.pause();
    }

    disconnectAvatar();
};

window.clearChatHistory = () => {
    document.getElementById('chatHistory').innerHTML = ''
    initMessages()
}

window.microphone = () => {
    if (document.getElementById('microphone').innerHTML === 'Stop Microphone') {
        // Stop microphone
        document.getElementById('microphone').disabled = true
        speechRecognizer.stopContinuousRecognitionAsync(
            () => {
                document.getElementById('microphone').innerHTML = 'Start Microphone'
                document.getElementById('microphone').disabled = false
            }, (err) => {
                console.log("Failed to stop continuous recognition:", err)
                document.getElementById('microphone').disabled = false
            })

        return
    }

    if (document.getElementById('useLocalVideoForIdle').checked) {
        if (!sessionActive) {
            connectAvatar()
        }

        setTimeout(() => {
            document.getElementById('audioPlayer').play()
        }, 5000)
    } else {
        document.getElementById('audioPlayer').play()
    }

    document.getElementById('microphone').disabled = true
    speechRecognizer.recognized = async (s, e) => {
        if (e.result.reason === SpeechSDK.ResultReason.RecognizedSpeech) {
            let userQuery = e.result.text.trim()
            if (userQuery === '') {
                return
            }

            // Auto stop microphone when a phrase is recognized, when it's not continuous conversation mode
            if (!document.getElementById('continuousConversation').checked) {
                document.getElementById('microphone').disabled = true
                speechRecognizer.stopContinuousRecognitionAsync(
                    () => {
                        document.getElementById('microphone').innerHTML = 'Start Microphone'
                        document.getElementById('microphone').disabled = false
                    }, (err) => {
                        console.log("Failed to stop continuous recognition:", err)
                        document.getElementById('microphone').disabled = false
                    })
            }

            handleUserQuery(userQuery,"","")
        }
    }

    speechRecognizer.startContinuousRecognitionAsync(
        () => {
            document.getElementById('microphone').innerHTML = 'Stop Microphone'
            document.getElementById('microphone').disabled = false
        }, (err) => {
            console.log("Failed to start continuous recognition:", err)
            document.getElementById('microphone').disabled = false
        })
}

window.updataEnableOyd = () => {
    if (document.getElementById('enableOyd').checked) {
        document.getElementById('cogSearchConfig').hidden = false
    } else {
        document.getElementById('cogSearchConfig').hidden = true
    }
}

window.updateTypeMessageBox = () => {
    if (document.getElementById('showTypeMessage').checked) {
        document.getElementById('userMessageBox').hidden = false
        document.getElementById('uploadImgIcon').hidden = false
        document.getElementById('userMessageBox').addEventListener('keyup', (e) => {
            if (e.key === 'Enter') {
                const userQuery = document.getElementById('userMessageBox').innerText
                const messageBox = document.getElementById('userMessageBox')
                const childImg = messageBox.querySelector("#picInput")
                if (childImg) {
                    childImg.style.width = "200px"
                    childImg.style.height = "200px"
                }
                let userQueryHTML = messageBox.innerHTML.trim("")
                if(userQueryHTML.startsWith('<img')){
                    userQueryHTML="<br/>"+userQueryHTML
                }
                if (userQuery !== '') {
                    handleUserQuery(userQuery.trim(''), userQueryHTML, imgUrl)
                    document.getElementById('userMessageBox').innerHTML = ''
                    imgUrl = ""
                }
            }
        })
        document.getElementById('uploadImgIcon').addEventListener('click', function() {
            imgUrl = "https://samples-files.com/samples/Images/jpg/1920-1080-sample.jpg"
            const userMessage = document.getElementById("userMessageBox");
            const childImg = userMessage.querySelector("#picInput");
            if (childImg) {
                userMessage.removeChild(childImg)
            }
            userMessage.innerHTML+='<br/><img id="picInput" src="https://samples-files.com/samples/Images/jpg/1920-1080-sample.jpg" style="width:100px;height:100px"/><br/><br/>'   
        });
    } else {
        document.getElementById('userMessageBox').hidden = true
        document.getElementById('uploadImgIcon').hidden = true
        imgUrl = ""
    }
}

window.updateLocalVideoForIdle = () => {
    if (document.getElementById('useLocalVideoForIdle').checked) {
        document.getElementById('showTypeMessageCheckbox').hidden = true
    } else {
        document.getElementById('showTypeMessageCheckbox').hidden = false
    }
}

window.updatePrivateEndpoint = () => {
    if (document.getElementById('enablePrivateEndpoint').checked) {
        document.getElementById('showPrivateEndpointCheckBox').hidden = false
    } else {
        document.getElementById('showPrivateEndpointCheckBox').hidden = true
    }
}