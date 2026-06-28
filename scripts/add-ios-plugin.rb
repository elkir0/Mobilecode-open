#!/usr/bin/env ruby
# Adds every plugin folder under ios/App/App/Plugins/* to the App target's
# compile sources, and sets the App Group entitlement on the App target.
require 'xcodeproj'

project_path = 'ios/App/App.xcodeproj'
project = Xcodeproj::Project.open(project_path)

app_target = project.targets.find { |t| t.name == 'App' }
abort('App target not found') unless app_target

app_group = project.main_group.children.find { |g| g.respond_to?(:display_name) && g.display_name == 'App' }
abort('App group not found') unless app_group

plugins_group = app_group.children.find { |g| g.respond_to?(:display_name) && g.display_name == 'Plugins' }
plugins_group ||= app_group.new_group('Plugins', 'Plugins')

added_total = 0
Dir.glob('ios/App/App/Plugins/*').select { |d| File.directory?(d) }.each do |dir|
  name = File.basename(dir)
  sub = plugins_group.children.find { |g| g.respond_to?(:display_name) && g.display_name == name }
  sub ||= plugins_group.new_group(name, name)
  added = []
  Dir.chdir(dir) do
    Dir.glob('*').select { |f| File.file?(f) }.each do |fname|
      next if sub.files.any? { |fr| fr.display_name == fname }
      ref = sub.new_reference(fname)
      added << ref
    end
  end
  app_target.add_file_references(added) unless added.empty?
  added_total += added.length
end

# Set App Group entitlement on the App target (Debug + Release)
entitlements_rel = 'App/OpenCodeRemote.entitlements'
app_target.build_configurations.each do |cfg|
  next unless ['Debug', 'Release'].include?(cfg.name)
  cfg.build_settings['CODE_SIGN_ENTITLEMENTS'] = entitlements_rel
end

project.save
puts "Added #{added_total} file reference(s); CODE_SIGN_ENTITLEMENTS=#{entitlements_rel}"
