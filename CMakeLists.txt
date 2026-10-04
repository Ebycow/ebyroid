cmake_minimum_required(VERSION 3.16.4)

if(CMAKE_GENERATOR MATCHES "Visual Studio")
  # WTF: https://gitlab.kitware.com/cmake/cmake/issues/19409
  set(CMAKE_GENERATOR_PLATFORM Win32 CACHE INTERNAL "")
endif()

# Project Name
project(ebyroid)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

if(MSVC)
  # Dumb options for dumb visual studio compiler
  add_compile_options(/utf-8 /std:c++17)
endif()

# Build a shared library named after the project from the files in `src/`
file(GLOB SOURCE_FILES "src/*.cc" "src/*.h")
add_library(${PROJECT_NAME} SHARED ${SOURCE_FILES} ${CMAKE_JS_SRC})

# Gives our library file a .node extension without any "lib" prefix
set_target_properties(${PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")

if(CMAKE_JS_INC)
  # Essential include files and libraries to build a node addon with CMake.js
  target_include_directories(${PROJECT_NAME} PRIVATE ${CMAKE_JS_INC})
  target_link_libraries(${PROJECT_NAME} ${CMAKE_JS_LIB})
else()
  # Cross build without CMake.js (see docker/Dockerfile).
  # NODE_INCLUDE_DIR: node headers, NODE_LIB: import library for node.exe of the same version
  target_include_directories(${PROJECT_NAME} PRIVATE ${NODE_INCLUDE_DIR})
  target_link_libraries(${PROJECT_NAME} ${NODE_LIB})
endif()

if(MINGW)
  # Do not depend on MinGW runtime DLLs that are absent on a plain Windows / wine
  target_link_options(${PROJECT_NAME} PRIVATE -static-libgcc -static-libstdc++ -static)
endif()
