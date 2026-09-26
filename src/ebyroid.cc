#include "ebyroid.h"

#include <cstdint>
#include <functional>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include <Windows.h>

#include "api_adapter.h"
#include "api_settings.h"
#include "ebyutil.h"

namespace ebyroid {

using std::string, std::vector, std::function, std::pair;

namespace {

ApiAdapter* NewAdapter(const string&, const string&, float);
int __stdcall HiraganaCallback(EventReasonCode, int32_t, IntPtr);
int __stdcall SpeechCallback(EventReasonCode, int32_t, uint64_t, IntPtr);
inline pair<bool, string> WithDirecory(const char* dir, function<pair<bool, string>(void)> yield);

}  // namespace

Ebyroid::~Ebyroid() {
  delete api_adapter_;
}

Ebyroid* Ebyroid::Create(const string& base_dir, const string& voice, float volume) {
  ApiAdapter* adapter = NewAdapter(base_dir, voice, volume);
  Ebyroid* ebyroid = new Ebyroid(adapter);
  return ebyroid;
}

int Ebyroid::Hiragana(const unsigned char* inbytes, unsigned char** outbytes, size_t* outsize) {
  if (api_adapter_ == nullptr) {
    throw std::runtime_error("VOICEROID API is not initialized");
  }
  std::unique_ptr<Response> response(new Response(api_adapter_));

  TJobParam param;
  param.mode_in_out = IOMODE_PLAIN_TO_AIKANA;
  param.user_data = response.get();

  int32_t job_id;
  if (ResultCode result = api_adapter_->TextToKana(&job_id, &param, (const char*) inbytes);
      result != ERR_SUCCESS) {
    char m[64];
    std::snprintf(m, sizeof(m), "TextToKana failed with the result code %d", result);
    throw std::runtime_error(m);
  }

  response->WaitForCompletion();

  // finalize
  if (ResultCode result = api_adapter_->CloseKana(job_id); result != ERR_SUCCESS) {
    throw std::runtime_error("wtf");
  }

  // write to output memory
  vector<unsigned char> buffer = response->End();
  *outsize = buffer.size();
  *outbytes = (unsigned char*) malloc(buffer.size() + 1);
  std::copy(buffer.begin(), buffer.end(), *outbytes);
  *(*outbytes + buffer.size()) = '\0';

  return 0;
}

int Ebyroid::Speech(const unsigned char* inbytes,
                    int16_t** outbytes,
                    size_t* outsize,
                    uint32_t mode) {
  if (api_adapter_ == nullptr) {
    throw std::runtime_error("VOICEROID API is not initialized");
  }
  std::unique_ptr<Response> response(new Response(api_adapter_));

  TJobParam param;
  param.mode_in_out = mode == 0u ? IOMODE_AIKANA_TO_WAVE : (JobInOut) mode;
  param.user_data = response.get();

  int32_t job_id;
  if (ResultCode result = api_adapter_->TextToSpeech(&job_id, &param, (const char*) inbytes);
      result != ERR_SUCCESS) {
    char m[64];
    std::snprintf(m, sizeof(m), "TextToSpeech failed with the result code %d", result);
    throw std::runtime_error(m);
  }

  response->WaitForCompletion();

  // finalize
  if (ResultCode result = api_adapter_->CloseSpeech(job_id); result != ERR_SUCCESS) {
    throw std::runtime_error("wtf");
  }

  // write to output memory
  vector<int16_t> buffer = response->End16();
  *outsize = buffer.size() * 2;  // sizeof(int16_t) == 2
  *outbytes = (int16_t*) malloc(buffer.size() * 2 + 1);
  std::copy(buffer.begin(), buffer.end(), *outbytes);
  *((char*) *outbytes + (buffer.size() * 2)) = '\0';

  return 0;
}

int Ebyroid::SpeechStream(const unsigned char* inbytes,
                          const SpeechChunkCallback& on_chunk,
                          uint32_t mode) {
  if (api_adapter_ == nullptr) {
    throw std::runtime_error("VOICEROID API is not initialized");
  }
  std::unique_ptr<Response> response(new Response(api_adapter_, on_chunk));

  TJobParam param;
  param.mode_in_out = mode == 0u ? IOMODE_AIKANA_TO_WAVE : (JobInOut) mode;
  param.user_data = response.get();

  int32_t job_id;
  if (ResultCode result = api_adapter_->TextToSpeech(&job_id, &param, (const char*) inbytes);
      result != ERR_SUCCESS) {
    char m[64];
    std::snprintf(m, sizeof(m), "TextToSpeech failed with the result code %d", result);
    throw std::runtime_error(m);
  }

  response->WaitForCompletion();

  if (ResultCode result = api_adapter_->CloseSpeech(job_id); result != ERR_SUCCESS) {
    throw std::runtime_error("failed to close streaming speech job");
  }

  return 0;
}

int Ebyroid::Convert(const ConvertParams& params,
                     const unsigned char* inbytes,
                     int16_t** outbytes,
                     size_t* outsize) {
  if (params.needs_reload) {
    delete api_adapter_;
    api_adapter_ = nullptr;
    api_adapter_ = NewAdapter(params.base_dir, params.voice, params.volume);
  }

  return Speech(inbytes, outbytes, outsize, IOMODE_PLAIN_TO_WAVE);
};

int Ebyroid::ConvertStream(const ConvertParams& params,
                           const unsigned char* inbytes,
                           const SpeechChunkCallback& on_chunk) {
  if (params.needs_reload) {
    delete api_adapter_;
    api_adapter_ = nullptr;
    api_adapter_ = NewAdapter(params.base_dir, params.voice, params.volume);
  }

  return SpeechStream(inbytes, on_chunk, IOMODE_PLAIN_TO_WAVE);
};

Response::Response(ApiAdapter* adapter, SpeechChunkCallback on_chunk)
    : api_adapter_(adapter),
      completion_event_(CreateEventA(NULL, TRUE, FALSE, NULL)),
      on_chunk_(std::move(on_chunk)) {
  if (completion_event_ == NULL) {
    string message = "CreateEvent failed with code ";
    message += std::to_string(GetLastError());
    throw std::runtime_error(message);
  }
}

Response::~Response() {
  if (completion_event_ != NULL) {
    CloseHandle((HANDLE) completion_event_);
  }
}

void Response::Write(char* bytes, uint32_t size) {
  buffer_.insert(std::end(buffer_), bytes, bytes + size);
}

void Response::Write16(int16_t* shorts, uint32_t size) {
  if (on_chunk_) {
    on_chunk_(shorts, size);
  } else {
    buffer_16_.insert(std::end(buffer_16_), shorts, shorts + size);
  }
}

vector<unsigned char> Response::End() {
  return std::move(buffer_);
}

vector<int16_t> Response::End16() {
  return std::move(buffer_16_);
}

void Response::WaitForCompletion() {
  if (DWORD result = WaitForSingleObject((HANDLE) completion_event_, INFINITE);
      result != WAIT_OBJECT_0) {
    string message = "WaitForSingleObject failed with code ";
    message += std::to_string(GetLastError());
    throw std::runtime_error(message);
  }
}

bool Response::SignalCompletion() {
  return SetEvent((HANDLE) completion_event_) != FALSE;
}

namespace {

ApiAdapter* NewAdapter(const string& base_dir, const string& voice, float volume) {
  SettingsBuilder builder(base_dir, voice);
  Settings settings = builder.Build();

  ApiAdapter* adapter = ApiAdapter::Create(settings.base_dir.c_str(), settings.dll_path.c_str());

  TConfig config;
  config.hz_voice_db = settings.frequency;
  config.msec_timeout = 1000;
  config.path_license = settings.license_path.c_str();
  config.dir_voice_dbs = settings.voice_dir.c_str();
  config.code_auth_seed = settings.seed;
  config.len_auth_seed = kLenSeedValue;

  if (ResultCode result = adapter->Init(&config); result != ERR_SUCCESS) {
    delete adapter;
    string message = "API initialization failed with code ";
    message += std::to_string(result);
    throw std::runtime_error(message);
  }

  auto [is_error, what] = WithDirecory(settings.base_dir.c_str(), [adapter, settings]() {
    if (ResultCode result = adapter->LangLoad(settings.language_dir.c_str());
        result != ERR_SUCCESS) {
      char m[64];
      std::snprintf(m, 64, "API LangLoad failed (could not load language) with code %d", result);
      return pair(true, string(m));
    }
    return pair(false, string());
  });
  if (is_error) {
    delete adapter;
    throw std::runtime_error(what);
  }

  if (ResultCode result = adapter->VoiceLoad(settings.voice_name.c_str()); result != ERR_SUCCESS) {
    delete adapter;
    string message = "API Load Voice failed (Could not load voice data) with code ";
    message += std::to_string(result);
    throw std::runtime_error(message);
  }

  uint32_t param_size = 0;
  if (ResultCode result = adapter->GetParam((void*) 0, &param_size);
      result != ERR_INSUFFICIENT) {  // NOTE: Code -20 is expected here
    delete adapter;
    string message = "API Get Param failed (Could not acquire the size) with code ";
    message += std::to_string(result);
    throw std::runtime_error(message);
  }

  char* param_buffer = new char[param_size];
  TTtsParam* param = (TTtsParam*) param_buffer;
  param->size = param_size;
  if (ResultCode result = adapter->GetParam(param, &param_size); result != ERR_SUCCESS) {
    delete[] param_buffer;
    delete adapter;
    string message = "API Get Param failed with code ";
    message += std::to_string(result);
    throw std::runtime_error(message);
  }
  param->extend_format = BOTH;
  param->proc_text_buf = HiraganaCallback;
  param->proc_raw_buf = SpeechCallback;
  param->proc_event_tts = nullptr;
  param->len_raw_buf_bytes = kConfigRawbufSize;
  param->volume = volume;
  param->speaker[0].volume = 1.0;

  if (ResultCode result = adapter->SetParam(param); result != ERR_SUCCESS) {
    delete[] param_buffer;
    delete adapter;
    string message = "API Set Param failed with code ";
    message += std::to_string(result);
    throw std::runtime_error(message);
  }

  delete[] param_buffer;

  return adapter;
}

int __stdcall HiraganaCallback(EventReasonCode reason_code, int32_t job_id, IntPtr user_data) {
  Response* const response = (Response*) user_data;
  ApiAdapter* api_adapter = response->api_adapter();

  if (reason_code != TEXTBUF_FULL && reason_code != TEXTBUF_FLUSH && reason_code != TEXTBUF_CLOSE) {
    // unexpected: may possibly lead to memory leak
    return 0;
  }

  static constexpr int kBufferSize = 0x1000;
  char* buffer = new char[kBufferSize];
  while (true) {
    uint32_t size, pos;
    if (ResultCode result = api_adapter->GetKana(job_id, buffer, kBufferSize, &size, &pos);
        result != ERR_SUCCESS) {
      break;
    }
    response->Write(buffer, size);
    if (kBufferSize > size) {
      break;
    }
  }
  delete[] buffer;

  if (reason_code == TEXTBUF_CLOSE) {
    if (!response->SignalCompletion()) {
      Eprintf("SetEvent failed with code %d", GetLastError());
    }
  }
  return 0;
}

int __stdcall SpeechCallback(EventReasonCode reason_code,
                             int32_t job_id,
                             uint64_t tick,
                             IntPtr user_data) {
  Response* const response = (Response*) user_data;
  ApiAdapter* api_adapter = response->api_adapter();

  if (reason_code != RAWBUF_FULL && reason_code != RAWBUF_FLUSH && reason_code != RAWBUF_CLOSE) {
    // unexpected: may possibly lead to memory leak
    return 0;
  }

  static constexpr int kBufferSize = 0xFFFF;
  int16_t* buffer = new int16_t[kBufferSize];
  while (true) {
    uint32_t size, pos;
    if (ResultCode result = api_adapter->GetData(job_id, buffer, kBufferSize, &size);
        result != ERR_SUCCESS) {
      break;
    }
    response->Write16(buffer, size);
    if (kBufferSize > size) {
      break;
    }
  }
  delete[] buffer;

  if (reason_code == RAWBUF_CLOSE) {
    if (!response->SignalCompletion()) {
      Eprintf("SetEvent failed with code %d", GetLastError());
    }
  }
  return 0;
}

inline pair<bool, string> WithDirecory(const char* dir, function<pair<bool, string>(void)> yield) {
  static constexpr size_t kErrMax = 64 + MAX_PATH;
  char org[MAX_PATH];
  if (DWORD result = GetCurrentDirectoryA(MAX_PATH, org); result == 0) {
    char m[64];
    std::snprintf(m, 64, "Could not get the current directory.\n\tErrorNo = %d", GetLastError());
    return pair(true, string(m));
  }
  if (BOOL result = SetCurrentDirectoryA(dir); !result) {
    char m[kErrMax];
    std::snprintf(m,
                  kErrMax,
                  "Could not change directory.\n\tErrorNo = %d\n\tTarget path: %s",
                  GetLastError(),
                  dir);
    return pair(true, string(m));
  }
  auto [is_error, what] = yield();
  if (BOOL result = SetCurrentDirectoryA(org); !result && !is_error) {
    char m[kErrMax];
    std::snprintf(m,
                  kErrMax,
                  "Could not change directory.\n\tErrorNo = %d\n\tTarget path: %s",
                  GetLastError(),
                  org);
    return pair(true, string(m));
  }
  if (is_error) {
    return pair(true, what);
  }
  return pair(false, string());
}

}  // namespace

}  // namespace ebyroid
