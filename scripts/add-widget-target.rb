#!/usr/bin/env ruby
# Creates the OpenCodeWidget Widget Extension target (.appex), embeds it into the
# App target (Embed App Extensions), and configures bundle id + App Group entitlement.
require "xcodeproj"

PROJECT_PATH = "ios/App/App.xcodeproj"
WIDGET_DIR   = "ios/Widget"           # repo-relative
WIDGET_REL   = "../Widget"            # project-relative (SRCROOT = ios/App/)
BUNDLE_ID    = "ai.opencode.remote.ios.OpenCodeWidget"

project = Xcodeproj::Project.open(PROJECT_PATH)

# Idempotent: reuse the target if it already exists from a prior run.
widget = project.targets.find { |t| t.name == "OpenCodeWidget" }
unless widget
  widget = project.new_target(:app_extension, "OpenCodeWidget", :ios, "16.1")
  puts "Created target OpenCodeWidget"
end

# Wire source file (idempotent). Fix path to be project-relative (../Widget/...).
swift_ref = project.files.find { |f| f.display_name == "OpenCodeWidget.swift" }
if swift_ref.nil?
  swift_ref = project.main_group.new_file("#{WIDGET_REL}/OpenCodeWidget.swift")
elsif swift_ref.path.to_s.include?("ios/Widget")
  swift_ref.path = "#{WIDGET_REL}/OpenCodeWidget.swift"
end
unless widget.source_build_phase.files_references.any? { |r| r.display_name == "OpenCodeWidget.swift" }
  widget.add_file_references([swift_ref])
end

# Build settings for the widget target (both configs).
widget.build_configurations.each do |cfg|
  s = cfg.build_settings
  s["PRODUCT_BUNDLE_IDENTIFIER"] = BUNDLE_ID
  s["PRODUCT_NAME"] = "$(TARGET_NAME)"
  s["INFOPLIST_FILE"] = "#{WIDGET_REL}/Info.plist"
  s["CODE_SIGN_ENTITLEMENTS"] = "#{WIDGET_REL}/OpenCodeWidget.entitlements"
  s["GENERATE_INFOPLIST_FILE"] = "NO"
  s["SKIP_INSTALL"] = "YES"
  s["LD_RUNPATH_SEARCH_PATHS"] = "$(inherited) @executable_path/Frameworks @executable_path/../../Frameworks"
  s["SWIFT_VERSION"] = "5.0"
  s["TARGETED_DEVICE_FAMILY"] = "1,2"
  s["CURRENT_PROJECT_VERSION"] = "1"
  s["MARKETING_VERSION"] = "1.0"
end

# Embed the .appex into the App target (Embed App Extensions, code-sign on copy).
app = project.targets.find { |t| t.name == "App" }
embed_phase = app.copy_files_build_phases.find { |p| p.symbol_dst_subfolder_spec == :plugins } ||
              app.new_copy_files_build_phase("Embed App Extensions")
embed_phase.dst_subfolder_spec = "13" # plugins
embed_phase.add_file_reference(widget.product_reference, true) rescue embed_phase.add_file_reference(widget.product_reference)

# Make the App target depend on the widget (build it first).
app.add_dependency(widget) unless app.dependencies.any? { |d| d.respond_to?(:target) && d.target == widget }

project.save
puts "Widget target configured, embedded in App, App Group entitlement set."
