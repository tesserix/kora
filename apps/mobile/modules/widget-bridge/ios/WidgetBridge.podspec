Pod::Spec.new do |s|
  s.name           = 'WidgetBridge'
  s.version        = '1.0.0'
  s.summary        = 'Writes the nutrition snapshot into the App Group for the Kora widgets'
  s.description    = 'Bridges the Expo app to the App Group UserDefaults suite that the iOS home screen widgets read from, and reloads widget timelines after writes.'
  s.author         = ''
  s.homepage       = 'https://github.com/tesserix/kora'
  s.platforms      = {
    :ios => '16.4'
  }
  s.source         = { git: '' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  # Swift/Objective-C compatibility
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
  }

  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
