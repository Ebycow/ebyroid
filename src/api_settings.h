#ifndef API_SETTINGS_H
#define API_SETTINGS_H

#include <string>

#include <cstdint>

namespace ebyroid {

static constexpr int32_t kFrequency44 = 0xAC44;
static constexpr int32_t kFrequency22 = 0x5622;
static constexpr const char* kDllFilename = "aitalked.dll";
static constexpr const char* kLicFilename = "aitalk.lic";
static constexpr const char* kWinDelimit = "\\";

struct Settings {
  std::string base_dir;
  std::string dll_path;
  std::string voice_dir;
  std::string voice_name;
  std::string language_dir;
  std::string license_path;
  const char* seed;
  uint32_t frequency;
};

class SettingsBuilder {
 public:
  SettingsBuilder(const std::string& base_dir, const std::string& voice_name)
      : base_dir_(base_dir), voice_name_(voice_name) {}

  Settings Build();

 private:
  std::string base_dir_;
  std::string voice_name_;
};

}  // namespace ebyroid

#endif  // API_SETTINGS_H
