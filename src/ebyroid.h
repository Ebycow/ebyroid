#ifndef EBYROID_H
#define EBYROID_H

#include <cstdint>
#include <functional>
#include <string>
#include <vector>

namespace ebyroid {

// forward-declaration to avoid including api_adapter.h
class ApiAdapter;

using SpeechChunkCallback = std::function<void(const int16_t*, size_t)>;

struct ConvertParams {
  bool needs_reload;
  char* base_dir;
  char* voice;
  float volume;
};

class Ebyroid {
 public:
  Ebyroid(const Ebyroid&) = delete;
  Ebyroid(Ebyroid&&) = delete;
  ~Ebyroid();

  static Ebyroid* Create(const std::string& base_dir, const std::string& voice, float volume);
  int Hiragana(const unsigned char* inbytes, unsigned char** outbytes, size_t* outsize);
  int Speech(const unsigned char* inbytes, int16_t** outbytes, size_t* outsize, uint32_t mode = 0u);
  int SpeechStream(const unsigned char* inbytes,
                   const SpeechChunkCallback& on_chunk,
                   uint32_t mode = 0u);
  int Convert(const ConvertParams& params,
              const unsigned char* inbytes,
              int16_t** outbytes,
              size_t* outsize);
  int ConvertStream(const ConvertParams& params,
                    const unsigned char* inbytes,
                    const SpeechChunkCallback& on_chunk);

 private:
  Ebyroid(ApiAdapter* api_adapter) : api_adapter_(api_adapter) {}
  ApiAdapter* api_adapter_;
};

// Which callback's *_CLOSE event finishes a job.
// A speech job also gets TEXTBUF_CLOSE, just before RAWBUF_CLOSE; it must wait for the latter.
enum class JobKind { kKana, kSpeech };

class Response {
 public:
  Response(ApiAdapter* adapter, JobKind kind, SpeechChunkCallback on_chunk = nullptr);
  ~Response();
  void Write(char* bytes, uint32_t size);
  void Write16(int16_t* shorts, uint32_t size);
  std::vector<unsigned char> End();
  std::vector<int16_t> End16();
  void WaitForCompletion();
  bool SignalCompletion();
  ApiAdapter* api_adapter() { return api_adapter_; };
  JobKind kind() const { return kind_; };

 private:
  ApiAdapter* api_adapter_;
  JobKind kind_;
  void* completion_event_;
  std::vector<unsigned char> buffer_;
  std::vector<int16_t> buffer_16_;
  SpeechChunkCallback on_chunk_;
};

}  // namespace ebyroid

#endif  // EBYROID_H
