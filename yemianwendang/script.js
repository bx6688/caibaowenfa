document.addEventListener('DOMContentLoaded', function() {
    // 获取DOM元素
    const sidebar = document.getElementById('sidebar');
    const mainContent = document.getElementById('main-content');
    const openSidebarBtn = document.getElementById('open-sidebar');
    const closeSidebarBtn = document.getElementById('close-sidebar');
    const corgiLogo = document.getElementById('corgi-logo');
    
    // 确保所有页面的菜单按钮都能切换侧边栏的显示状态
    const menuBtns = document.querySelectorAll('.menu-btn, #open-sidebar');
    menuBtns.forEach(btn => {
        if (btn && !sidebar) {
            btn.addEventListener('click', function() {
                // 切换侧边栏的显示状态
                if (sidebar.classList.contains('active')) {
                    sidebar.classList.remove('active');
                    if (mainContent && window.innerWidth > 768) {
                        mainContent.classList.remove('shifted');
                    }
                } else {
                    sidebar.classList.add('active');
                    if (mainContent && window.innerWidth > 768) {
                        mainContent.classList.add('shifted');
                    }
                }
            });
        }
    })
    
    // 获取所有菜单项
    const menuItems = document.querySelectorAll('.menu-list a');
    
    // 用户个人信息相关元素
    const editProfileBtn = document.getElementById('edit-profile-btn');
    const profileModal = document.getElementById('profile-modal');
    const closeModal = document.querySelector('.close-modal');
    const cancelBtn = document.querySelector('.cancel-btn');
    const saveProfileBtn = document.getElementById('save-profile');
    const userAvatar = document.getElementById('user-avatar');
    const userName = document.querySelector('.user-name');
    const userStatus = document.querySelector('.user-status');
    const editUsername = document.getElementById('edit-username');
    const editAvatar = document.getElementById('edit-avatar');
    const editStatus = document.getElementById('edit-status');
    
    // 首页展示图
    if (corgiLogo) {
        corgiLogo.src = 'home-picture.jpg';
    }
    
    // 设置用户头像默认使用picture.png
    if (userAvatar) {
        // 首先检查本地存储中是否有保存的头像
        const savedAvatar = localStorage.getItem('userAvatar');
        if (savedAvatar && savedAvatar !== '') {
            userAvatar.src = savedAvatar;
        } else {
            // 没有保存的头像时，使用默认的picture.jpg
            userAvatar.src = 'picture.jpg';
        }
    }

    // 切换侧边栏
    if (openSidebarBtn && sidebar && mainContent) {
        openSidebarBtn.addEventListener('click', function() {
            // 切换侧边栏的显示状态
            if (sidebar.classList.contains('active')) {
                sidebar.classList.remove('active');
                if (window.innerWidth > 768) {
                    mainContent.classList.remove('shifted');
                }
            } else {
                sidebar.classList.add('active');
                if (window.innerWidth > 768) {
                    mainContent.classList.add('shifted');
                }
            }
        });
    }

    // 关闭侧边栏
    if (closeSidebarBtn && sidebar && mainContent) {
      closeSidebarBtn.addEventListener('click', function() {
            sidebar.classList.remove('active');
            if (window.innerWidth > 768) {
                mainContent.classList.remove('shifted');
            }
        });
    }
    
    // 为菜单项添加点击事件
    menuItems.forEach(item => {
        item.addEventListener('click', function() {
            // 在移动设备上点击菜单项后关闭侧边栏
            if (window.innerWidth <= 768) {
                sidebar.classList.remove('active');
            }
            
            // 移除所有菜单项的active类
            menuItems.forEach(i => i.classList.remove('active'));
            // 为当前点击的菜单项添加active类
            this.classList.add('active');
        });
    });
    
    // 高亮当前页面对应的菜单项
    const currentPath = window.location.pathname;
    menuItems.forEach(item => {
        const itemPath = item.getAttribute('href');
        if (currentPath.endsWith(itemPath)) {
            item.classList.add('active');
        }
    });

    // 点击侧边栏外部区域关闭侧边栏
    document.addEventListener('click', function(event) {
        const sidebar = document.getElementById('sidebar');
        const mainContent = document.getElementById('main-content');
        const openSidebarBtn = document.querySelector('.menu-btn');
        const windowWidth = window.innerWidth;
        
        if (sidebar && 
            !sidebar.contains(event.target) && 
            event.target !== openSidebarBtn && 
            !event.target.closest('.menu-btn') && 
            sidebar.classList.contains('active')) {
            sidebar.classList.remove('active');
            // 只在大屏幕上移除shifted类
            if (windowWidth > 768 && mainContent) {
                mainContent.classList.remove('shifted');
            }
        }
    });
    
    // 监听窗口大小变化，调整布局
    window.addEventListener('resize', function() {
        const windowWidth = window.innerWidth;
        const sidebar = document.getElementById('sidebar');
        const mainContent = document.getElementById('main-content');
        
        if (sidebar && mainContent) {
            if (windowWidth <= 768 && mainContent.classList.contains('shifted')) {
                // 在小屏幕上不移动主内容区域
                mainContent.classList.remove('shifted');
            } else if (windowWidth > 768 && sidebar.classList.contains('active') && !mainContent.classList.contains('shifted')) {
                // 在大屏幕上恢复主内容区域的移动
                mainContent.classList.add('shifted');
            }
        }
    });

    // 为获取APP按钮添加点击事件
    const getAppBtns = document.querySelectorAll('.get-app-btn');
    if (getAppBtns.length > 0) {
        getAppBtns.forEach(btn => {
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                alert('APP下载功能将在此实现');
            });
        });
    }
    
    // 为开启对话按钮添加点击事件
    const startDialogBtn = document.querySelector('.start-dialog-btn');
    if (startDialogBtn) {
        startDialogBtn.addEventListener('click', function(e) {
            e.preventDefault();
            window.location.href = 'dialog.html';
        });
    }
    
    // 为柯基logo添加点击动画效果
    if (corgiLogo) {
        corgiLogo.addEventListener('click', function() {
            this.classList.add('clicked');
            setTimeout(() => {
                this.classList.remove('clicked');
            }, 300);
            // 点击柯基logo返回首页
            window.location.href = 'index.html';
        });
    }
    
    // 用户个人信息编辑功能
    // 打开编辑个人信息对话框
    if (editProfileBtn && profileModal) {
        editProfileBtn.addEventListener('click', function() {
            // 重新获取最新的DOM元素
            const editUsername = document.getElementById('edit-username');
            const editAvatar = document.getElementById('edit-avatar');
            const editStatus = document.getElementById('edit-status');
            const userName = document.querySelector('.user-name');
            const userAvatar = document.getElementById('user-avatar');
            const userStatus = document.querySelector('.user-status');
            
            if (editUsername && editAvatar && editStatus && userName && userAvatar && userStatus) {
                // 填充当前信息到表单
                editUsername.value = userName.textContent;
                editAvatar.value = userAvatar.src;
                editStatus.value = userStatus.textContent;
                
                // 显示对话框
                profileModal.classList.add('active');
            }
        });
    }
    
    // 关闭对话框的多种方式
    if (profileModal) {
        function closeProfileModal() {
            profileModal.classList.remove('active');
        }
        
        // 获取关闭按钮
        const closeModal = document.querySelector('.close-modal');
        if (closeModal) {
            closeModal.addEventListener('click', closeProfileModal);
        }
        
        // 获取取消按钮
        const cancelBtn = document.querySelector('.cancel-btn');
        if (cancelBtn) {
            cancelBtn.addEventListener('click', closeProfileModal);
        }
        
        // 点击对话框外部关闭
        profileModal.addEventListener('click', function(event) {
            if (event.target === profileModal) {
                closeProfileModal();
            }
        });
    }
    
    // 保存个人信息
    if (saveProfileBtn && profileModal) {
        saveProfileBtn.addEventListener('click', function() {
            // 重新获取最新的DOM元素
            const editUsername = document.getElementById('edit-username');
            const editAvatar = document.getElementById('edit-avatar');
            const editStatus = document.getElementById('edit-status');
            const userName = document.querySelector('.user-name');
            const userAvatar = document.getElementById('user-avatar');
            const userStatus = document.querySelector('.user-status');
            
            if (editUsername && editAvatar && editStatus && userName && userStatus && userAvatar) {
                // 获取表单数据
                const newUsername = editUsername.value.trim();
                const newAvatar = editAvatar.value.trim();
                const newStatus = editStatus.value;
                
                // 简单验证
                if (newUsername === '') {
                    alert('用户名不能为空');
                    return;
                }
                
                // 更新显示的信息
                userName.textContent = newUsername;
                userStatus.textContent = newStatus;
                
                // 如果提供了有效的头像URL，则更新头像
                if (newAvatar !== '') {
                    userAvatar.src = newAvatar;
                }
                
                // 关闭对话框
                profileModal.classList.remove('active');
                
                // 可以在这里添加保存到本地存储或发送到服务器的代码
                localStorage.setItem('userName', newUsername);
                localStorage.setItem('userAvatar', newAvatar);
                localStorage.setItem('userStatus', newStatus);
            }
        });
    }
    
    // 页面加载时从本地存储加载用户信息
    function loadUserProfile() {
        const userName = document.querySelector('.user-name');
        const userStatus = document.querySelector('.user-status');
        const userAvatar = document.getElementById('user-avatar');
        
        if (userName && userStatus && userAvatar) {
            const savedUsername = localStorage.getItem('userName');
            const savedAvatar = localStorage.getItem('userAvatar');
            const savedStatus = localStorage.getItem('userStatus');
            
            if (savedUsername) {
                userName.textContent = savedUsername;
            }
            
            if (savedStatus) {
                userStatus.textContent = savedStatus;
            }
            
            if (savedAvatar) {
                userAvatar.src = savedAvatar;
            }
        }
    }
    
    // 加载用户信息
    loadUserProfile();
});