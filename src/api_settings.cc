#include "api_settings.h"

#include <stdexcept>

#include "ebyutil.h"

namespace ebyroid {

using std::string;

Settings SettingsBuilder::Build() {
  Settings settings;
  settings.base_dir = base_dir_;
  settings.voice_name = voice_name_;
  settings.dll_path = base_dir_ + kWinDelimit + kDllFilename;
  settings.license_path = base_dir_ + kWinDelimit + kLicFilename;

  Dprintf("SettingBuilder\nbase_dir=%s\ndll_path=%s\nlicense_path=%s\nvoice_name=%s",
          settings.base_dir.c_str(),
          settings.dll_path.c_str(),
          settings.license_path.c_str(),
          settings.voice_name.c_str());

  if (voice_name_.find("_22") != string::npos) {
    // this means the given library is VOICEROID+
    settings.frequency = kFrequency22;

    settings.voice_dir = base_dir_ + kWinDelimit + "voice";
    settings.language_dir = base_dir_ + kWinDelimit + "lang";
    if (voice_name_ == "kiritan_22") {
      settings.seed = EBY_SEED_B;
    } else if (voice_name_ == "zunko_22") {
      settings.seed = EBY_SEED_C;
    } else if (voice_name_ == "akane_22") {
      settings.seed = EBY_SEED_D;
    } else if (voice_name_ == "aoi_22") {
      settings.seed = EBY_SEED_E;
    } else {
      char m[64];
      std::snprintf(
          m, 64, "Unsupported VOICEROID+ library '%s' was given.", settings.voice_name.c_str());
      throw std::runtime_error(m);
    }
  } else {
    // this means it is either VOICEROID2 or an unexpected library
    // try to setup as VOICEROID2 anyways
    settings.frequency = kFrequency44;

    settings.voice_dir = base_dir_ + kWinDelimit + "Voice";
    settings.language_dir = base_dir_ + kWinDelimit + "Lang" + kWinDelimit + "standard";
    settings.seed = EBY_SEED_A;
  }

  Dprintf("SettingBuilder\nfrequency=%d\nlanguage_dir=%s\nvoice_dir=%s",
          settings.frequency,
          settings.language_dir.c_str(),
          settings.voice_dir.c_str());

  return settings;
}

}  // namespace ebyroid
